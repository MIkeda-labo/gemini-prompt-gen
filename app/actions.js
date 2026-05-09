"use server";

import { GoogleGenAI } from '@google/genai';

// ④ OpenAI依存を排除し、Gemini API一本に統一
// 検証（ダブルチェック）もGeminiの別モデル（gemini-2.5-pro）が担う
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

export async function regenerateTagsAct(intent) {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `目的: ${intent}\n\nユーザーの目的に合った「プロンプト改善の観点」を6〜8個生成し、JSONのみを返してください（説明や\`\`\`は不要）。\n例:\n[{"label":"短く","desc":"10文字以内"},...]`,
      config: {
        responseMimeType: "application/json"
      }
    });

    const text = response.text.replace(/```json|```/g, "").trim();
    return JSON.parse(text);
  } catch (err) {
    console.error("regenerateTags error:", err);
    return { tagDebugError: err.message || String(err) };
  }
}

// 追加: 目的からNot変数（除外すべき内容・失敗事例）を抽出
export async function generateNotTagsAct(intent) {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `目的: ${intent}\n\nこの目的から推測される、LLMに指示する際の問題点として除外すべき『Not変数』を6〜8個抽出してください。「不適切」や「倫理的リスク」だけでなく、「定番の場所」「固有名詞」「特定の方法のキーワード」なども積極的に含めてください。必ずJSON配列の形式のみを返してください。\n例:\n[{"label":"個人情報","desc":"漏洩のリスク"}, {"label":"東京・大阪など","desc":"定番の場所"}, {"label":"特定の企業名(固有名詞)","desc":"一般化するため"}, {"label":"〇〇法等の手技","desc":"他の方法を促すため"}]`,
      config: {
        responseMimeType: "application/json"
      }
    });

    const jsonMatch = response.text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return JSON.parse(response.text.trim());
  } catch (err) {
    console.error("generateNotTags error:", err);
    // Fallback if API fails
    return [
      { label: "定番の場所", desc: "ありきたりになる" },
      { label: "固有名詞", desc: "一般化するため" },
      { label: "特定の手法/方法", desc: "選択肢を狭めない" }
    ];
  }
}

// app/actions.js (一番下に追記)

// ① Geminiの機能を使ったベクトル化 (OpenAIの代わり)
export async function getGeminiEmbeddingsAct(texts) {
  try {
    const embeddings = [];
    for (const text of texts) {
      const response = await ai.models.embedContent({
        model: 'gemini-embedding-001',
        contents: text,
      });
      embeddings.push(response.embeddings[0].values);
    }
    return embeddings;
  } catch (err) {
    throw new Error("Embedding error: " + err);
  }
}

// ④ ダブルチェック関数 — OpenAIを廃止し、Gemini同士で2段階検証
export async function generateAndVerifyReasoningAct(intent, notParamsStr) {
  try {
    // Step1: gemini-2.5-flash が Code Execution を使って原案（下書き）を作成
    //        Pythonコード実行で「意味的に近い概念」を推測させ、除外理由を骨格として組み立てる
    const geminiRes = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `目的: ${intent}\n以下のキーワードに対して、Pythonコードを実行して意味的に近い概念を推測しなさい。キーワード: ${notParamsStr}`,
      config: { tools: [{ codeExecution: {} }] }
    });
    const geminiDraft = geminiRes.text;

    // Step2: 同じGemini APIで「検証・添削モデル」として gemini-2.5-flash を再度呼び出す
    //        ← 旧: OpenAI(GPT-4o) → 新: Gemini(gemini-2.5-flash) に置き換え
    //        役割はOpenAI時代と同じ「厳格な添削者・司書」だが、外部APIへのデータ送信がなくなりセキュリティ向上
    const verifyRes = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [{
            text: `あなたはプロのAIエンジニアです。ユーザーの目的は「${intent}」です。
以下のGeminiが作成した『禁止・除外事項の下書き』を評価し、次の形式で構造化された文書を出力してください。

【出力形式】
1. まず冒頭に、ユーザーの目的達成の観点から、なぜこれらの要素を除外すべきかの概要を1〜2文で述べてください。
2. 各Not変数（除外項目）ごとに「### 項目名」の見出しをつけ、理由を箇条書き（太字の小見出し付き）で詳細に記述してください。
   理由は「情報の中立性」「過剰抑制のリスク」「目的との関連性」「AIの推論への影響」等の多角的な観点から述べてください。
3. 最後に「---」で区切り、「システムは以下の指示に従ってください：」というヘッダーの後に、禁止ルールを番号付きリストで提示してください。

【Geminiの下書き】
${geminiDraft}`
          }]
        }
      ]
    });
    const openaiFinal = verifyRes.text; // 変数名は互換性のため維持

    // ダブルチェック済みの2つの結果をフロントへ返す
    return { geminiDraft, openaiFinal };
  } catch (err) {
    throw new Error("Verify error: " + err);
  }
}

export async function updateBtnLabelAct(intent) {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `目的: ${intent}\n\nユーザーの目的に合ったボタンラベルを1つ生成してください。\n形式：{"label": "12文字以内の動詞フレーズ ↗"}\n例：{"label": "名所を確認する ↗"}`,
      config: {
        responseMimeType: "application/json"
      }
    });
    const json = JSON.parse(response.text.trim());
    return json.label;
  } catch (err) {
    console.error("updateBtnLabel error:", err);
    return "最適なプロンプトを生成 ↗";
  }
}

export async function generateOptimizedAct(intent, currentPrompt, tagsStr, fewShots = []) {
  try {
    const fewShotBlock = fewShots.length > 0
      ? `\n\n【重要：参考にするお手本（Few-shot）】\n以下の過去の成功例のトーンや構成、具体性を参考にしてください：\n${fewShots.map((f, i) => `例${i + 1}:\n${f}`).join("\n\n")}\n`
      : "";

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `目的: ${intent || "未入力"}
現在のプロンプト: ${currentPrompt || "未入力"}
重視する観点: ${tagsStr || "なし"}${fewShotBlock}

プロンプトエンジニアリングの専門家として、最高品質の改善案を提案してください。最適化されたプロンプトはマークダウン形式で出力し、もし不足項目があれば「最も一般的な値」をAIが仮定して代入し、具体的な回答を生成するように指示文を構築してください。
出力は必ず以下のJSON形式のみとし、説明や\`\`\`は一切不要です:
{"optimized":"マークダウン形式でフォーマットされた改善済みのプロンプト","reasons":["改善点1","改善点2"],"tips":"一言アドバイス"}`,
      config: {
        responseMimeType: "application/json"
      }
    });

    const text = response.text.replace(/```json|```/g, "").trim();
    return { success: true, data: JSON.parse(text) };
  } catch (err) {
    console.error("generateOptimized error:", err);
    return { success: false, error: err.message, stack: err.stack };
  }
}

// 追加: 生成したプロンプトを実際にGeminiで実行する
// ① プロンプトの組み立て順序（アテンション最適化）:
//   [本体] 実行プロンプト（土台）
//   [次]   RAGコンテキスト（参考情報）
//   [次]   ユーザー追加指示（最高優先）← 生成直前に近い位置で優先度を強調
//   [末尾] Not変数・禁止条件 ← 生成の直前に配置することでアテンションが最も効く
export async function executePromptAct(promptStr, forbiddenContext = "", ragTexts = [], userDirective = "") {
  try {
    // 各ブロックを構築（末尾ほど生成に強く影響するため、禁止条件を最後に置く）
    const ragContext = (ragTexts && ragTexts.length > 0)
      ? `\n\n【参考情報 (RAG)】\n以下のローカルファイルの関連情報を参考に回答を組み立ててください：\n${ragTexts.join("\n\n---\n\n")}\n`
      : "";

    // ユーザー追加指示：スナップショット後に追記された「最優先の条件」
    const userDirectiveBlock = userDirective.trim()
      ? `\n\n═══════════════════════════════════════\n【最優先：ユーザーからの直接指示】\n以下はユーザーが直接記述した条件・要望です。実行プロンプトの内容よりも優先して反映してください：\n${userDirective.trim()}\n═══════════════════════════════════════\n`
      : "";

    // 禁止条件：生成の直前（末尾）に配置することでLLMのアテンションが最も強く効く
    const forbiddenPrompt = forbiddenContext
      ? `\n\n═══════════════════════════════════════\n【厳守：禁止条件・Not変数】\n以下の条件に違反する表現・アプローチは回答に絶対に含めないでください：\n${forbiddenContext}\n═══════════════════════════════════════`
      : "";

    // ① 順序: 本体 → RAG → ユーザー追加指示 → 禁止条件（末尾）
    const finalPrompt = `あなたは優秀なAIアシスタントです。以下の指示に従いタスクを実行し、最終的な出力（回答そのもの）を生成してください。
※プロンプト文のオウム返しや構成案の提示はしないでください。

▼▼実行用プロンプト（土台）ここから▼▼
${promptStr}
▲▲実行用プロンプトここまで▲▲${ragContext}${userDirectiveBlock}${forbiddenPrompt}`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: finalPrompt
    });

    return response.text.trim();
  } catch (err) {
    console.error("executePrompt error:", err);
    return "実行中にエラーが発生しました: " + err.message;
  }
}

// 追加: プロンプトをテンプレート化する（固有名詞や数値を空白にする）
export async function templatizePromptAct(promptStr) {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `以下のプロンプトを、ユーザーが後から入力しやすい「汎用的なテンプレート」に変換してください。

【変換ルール】
1. 固有名詞や具体的な数値（旅行先、期間、時期など）は、全て「**項目名：**」という形式に置き換え、後ろの[ ]や仮定文は削除してください。
   例：「**旅行期間:** [旅行期間]（一般的な〜）」 → 「**旅行期間：**」
2. リスト項目（1. や 2. など）の末尾には、必ず全角コロン「：」を付け加えてください。
   例：「1. 観光ルート」 → 「1. 観光ルート：」
3. プロンプトの指示構造は維持し、出力は変換後の本文のみとしてください。

【変換対象】
${promptStr}`
    });
    return response.text.trim();
  } catch (err) {
    console.error("templatizePrompt error:", err);
    return promptStr; // エラー時はそのまま返す
  }
}
