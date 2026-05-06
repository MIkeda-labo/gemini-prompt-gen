"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { regenerateTagsAct, updateBtnLabelAct, generateOptimizedAct, generateNotTagsAct, getGeminiEmbeddingsAct, executePromptAct, generateAndVerifyReasoningAct, templatizePromptAct } from "./actions";
import ReactMarkdown from 'react-markdown';
import { clearDB, putDocsToDB, getAllDocsFromDB } from "./lib/db";


const STORAGE_KEY = "prompt_history_gemini_v1_gen";

const DEFAULT_TAGS = [
  { label: "正確性", desc: "信頼できる回答" },
  { label: "簡潔さ", desc: "短くまとめる" },
  { label: "詳しさ", desc: "詳細な説明" },
  { label: "ステップ形式", desc: "手順で分ける" },
  { label: "具体例", desc: "例を交える" },
  { label: "理由の説明", desc: "なぜかを解説" },
];

const DEFAULT_NOT_TAGS = [
  { label: "定番の場所", desc: "ありきたりになる" },
  { label: "固有名詞", desc: "一般化するため" },
  { label: "特定の手法", desc: "選択肢を狭めない" }
];


function Spinner() {
  return <span className="spinner" />;
}

// フォルダ読み込み時にチャンク分割する関数 (500-1000文字程度に)
function chunkText(text, maxLen = 800) {
  const chunks = [];
  let current = 0;
  while (current < text.length) {
    chunks.push(text.slice(current, current + maxLen));
    current += maxLen;
  }
  return chunks;
}

// ③ Obsidian記法の前処理：WikiLinkとYAML frontmatterを除去して純粹なテキストに整形
function preprocessObsidianText(text) {
  // YAML frontmatterを除去 (---で挙われた先頭ブロック)
  let cleaned = text.replace(/^---[\s\S]*?---\n?/, "");
  // Wikilink [[...]]をファイル名またはエイリアスのみに展開 ([[Page|Alias]] → Alias, [[Page]] → Page)
  cleaned = cleaned.replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2");
  cleaned = cleaned.replace(/\[\[([^\]]+)\]\]/g, "$1");
  return cleaned.trim();
}

// コサイン類似度の計算関数
function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0.0;
  let normA = 0.0;
  let normB = 0.0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] ** 2;
    normB += vecB[i] ** 2;
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export default function Home() {
  const [tab, setTab] = useState("input");
  const [intent, setIntent] = useState("");
  const [currentPrompt, setCurrentPrompt] = useState("");
  const [tags, setTags] = useState(DEFAULT_TAGS);
  const [selectedTags, setSelectedTags] = useState(new Set(["正確性"]));
  const [tagsLoading, setTagsLoading] = useState(false);
  const [btnLabel, setBtnLabel] = useState("最適なプロンプトを生成 ↗");
  const [genLoading, setGenLoading] = useState(false);
  const [output, setOutput] = useState(null);
  const [history, setHistory] = useState([]);

  // 新規: Gemini実行用
  const [executionResult, setExecutionResult] = useState("");
  const [executionLoading, setExecutionLoading] = useState(false);
  const [promptPreview, setPromptPreview] = useState(true);
  const [finalPromptPreview, setFinalPromptPreview] = useState(""); // 実行時に送る最終プロンプトの控え

  const [myPrompts, setMyPrompts] = useState([]); // マイプロンプト集
  const [selectedMyPromptId, setSelectedMyPromptId] = useState(null); // 選択中のテンプレートID
  const [selectedFewShotIds, setSelectedFewShotIds] = useState(new Set()); // Few-shotとして選択された履歴ID群

  // ────────────────────────────────────────────────────────────
  // 【追記検出の仕組み】
  // ユーザーの操作フロー:
  //   Step1: 「今使っているプロンプト」に元の指示を入力
  //   Step2: 「最適なプロンプトを生成」ボタン → この時点のcurrentPromptを記録（スナップショット）
  //   Step3: 1回目の「Geminiで実行」→ 追記なし → Geminiが不足情報を指摘してくれる
  //   Step4: Geminiの指摘を受けて「今使っているプロンプト」に訪問時期等を追記
  //   Step5: 2回目の「Geminiで実行」→ 追記部分を自動検出 → 最優先として反映
  // ────────────────────────────────────────────────────────────
  const [originalPromptSnapshot, setOriginalPromptSnapshot] = useState("");

  // Not変数とRAG用の状態
  const [notTags, setNotTags] = useState(DEFAULT_NOT_TAGS);
  const [selectedNotTags, setSelectedNotTags] = useState(new Set());
  const [notTagsLoading, setNotTagsLoading] = useState(false);


  const [loadedFileNames, setLoadedFileNames] = useState([]); // 新規: 読み込んだファイル名
  const [docsLoading, setDocsLoading] = useState(false);

  const [ragReasoning, setRagReasoning] = useState("");
  const [ragLoading, setRagLoading] = useState(false);

  const tagTimerRef = useRef(null);
  const btnTimerRef = useRef(null);
  const notTagTimerRef = useRef(null);

  // Client-side localStorage for history
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setHistory(JSON.parse(stored));

      const storedMy = localStorage.getItem('my_prompts');
      if (storedMy) setMyPrompts(JSON.parse(storedMy));
    } catch (err) { }
  }, []);

  const saveHistory = (items) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch { }
  };

  const saveMyPrompts = (items) => {
    try {
      localStorage.setItem('my_prompts', JSON.stringify(items));
    } catch { }
  };

  // 永続化の自動同期
  useEffect(() => {
    if (history.length > 0) saveHistory(history);
  }, [history]);

  useEffect(() => {
    if (myPrompts.length > 0) saveMyPrompts(myPrompts);
  }, [myPrompts]);

  useEffect(() => {
    clearTimeout(tagTimerRef.current);
    clearTimeout(notTagTimerRef.current);

    if (!intent.trim() || intent.trim().length < 5) {
      setTags(DEFAULT_TAGS);
      setNotTags([]);
      return;
    }

    tagTimerRef.current = setTimeout(() => regenerateTags(intent), 1500);
    notTagTimerRef.current = setTimeout(() => generateNotTags(intent), 1500);
  }, [intent]);

  useEffect(() => {
    clearTimeout(btnTimerRef.current);
    if (!intent.trim()) {
      setBtnLabel("最適なプロンプトを生成 ↗");
      return;
    }
    btnTimerRef.current = setTimeout(() => updateBtnLabel(intent), 1500);
  }, [intent]);

  // --- RAG自動トリガー機能 ---
  const autoGenerateReasoning = useCallback(async () => {
    if (selectedNotTags.size === 0) {
      setRagReasoning("");
      return;
    }
    setRagLoading(true);
    setRagReasoning("");

    const notParamsStr = [...selectedNotTags].join("、");

    // 変更：新しいダブルチェックAPIを呼ぶ
    const { geminiDraft, openaiFinal } = await generateAndVerifyReasoningAct(intent, notParamsStr);
    // とりあえず完成品(OpenAI版)をテキストエリアにセットしつつ、ユーザーが見えるようにする
    setRagReasoning(openaiFinal);
    // ※UI上で原案(geminiDraft)と完成品(openaiFinal)を出しわけるStateを作ってもOKです！

    setRagLoading(false);
  }, [selectedNotTags, intent]);


  useEffect(() => {
    // ユーザーがNot変数を選択し終わった後、1秒待ってから自動で理由を生成する
    if (selectedNotTags.size > 0) {
      const timer = setTimeout(() => {
        autoGenerateReasoning();
      }, 1000);
      return () => clearTimeout(timer);
    } else {
      setRagReasoning("");
    }
  }, [selectedNotTags, autoGenerateReasoning]);


  useEffect(() => {
    // アプリ起動時にセキュリティのためDBを強制クリア
    clearDB().catch(console.error);
  }, []);

  // ---

  async function regenerateTags(text) {
    setTagsLoading(true);
    const parsed = await regenerateTagsAct(text);
    if (Array.isArray(parsed) && parsed.length > 0) {
      setTags(parsed);
      setSelectedTags(new Set([parsed[0].label]));
    } else {
      setTags(DEFAULT_TAGS);
    }
    setTagsLoading(false);
  }

  async function generateNotTags(text) {
    setNotTagsLoading(true);
    const parsed = await generateNotTagsAct(text);
    if (Array.isArray(parsed) && parsed.length > 0) {
      setNotTags(parsed);
    } else {
      setNotTags([]);
    }
    setNotTagsLoading(false);
  }

  async function updateBtnLabel(text) {
    const label = await updateBtnLabelAct(text);
    if (label) setBtnLabel(label);
  }

  function toggleTag(label) {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  }

  function toggleNotTag(label) {
    setSelectedNotTags((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  }

  function appendToCurrentPrompt(label) {
    setCurrentPrompt(prev => prev + (prev.trim() ? "\n" : "") + label + "：");
  }

  // ①② Vault自動認識対応版 processDirectory
  // isVault=true の場合: .obsidianフォルダをスキップ
  // .mdファイルは常にObsidian記法（WikiLink・YAML frontmatter）を前処理で除去（③）
  async function processDirectory(dirHandle, allChunks, fileNamesArray, isVault = false) {
    for await (const entry of dirHandle.values()) {
      if (entry.kind === 'directory') {
        // ② .obsidianフォルダはObsidianのシステムファイルなのでスキップ
        if (entry.name === '.obsidian') continue;
        const subDirHandle = await dirHandle.getDirectoryHandle(entry.name);
        await processDirectory(subDirHandle, allChunks, fileNamesArray, isVault);
      } else if (entry.kind === 'file') {
        if (!entry.name.match(/\.(txt|md|csv|json|js|jsx|ts|tsx|py|html|css|php|go)$/i)) continue;
        const file = await entry.getFile();
        if (file.size > 1048576) continue;

        let text = await file.text();

        // ③ .mdファイルは常にWikiLink・YAML frontmatterを前処理で除去してクリーンなテキストに
        if (entry.name.endsWith('.md')) {
          text = preprocessObsidianText(text);
        }

        const chunks = chunkText(text, 1000);
        chunks.forEach(c => {
          if (c.trim()) allChunks.push({ filename: entry.name, text: c });
        });
        if (!fileNamesArray.includes(entry.name)) {
          fileNamesArray.push(entry.name);
        }
      }
    }
  }


  // --- ローカルディレクトリ読み込み & 埋め込み (RAG) ---
  async function loadDirectoryFiles() {
    try {
      if (!window.showDirectoryPicker) {
        alert("ご利用のブラウザはローカルフォルダ読み取り機能に対応していません。\nChromeやEdgeなどをご利用ください。");
        return;
      }

      const dirHandle = await showDirectoryPicker({ mode: 'read' });
      setDocsLoading(true);

      // ② Vault自動認識: .obsidianフォルダの有無でObsidian Vaultか判定
      let isVault = false;
      for await (const entry of dirHandle.values()) {
        if (entry.kind === 'directory' && entry.name === '.obsidian') {
          isVault = true;
          break;
        }
      }

      // Vaultでない場合のみ案内アラートを表示（Vaultは自動認識でスキップ）
      if (!isVault) {
        alert("【ご注意】\nブラウザの仕組み上、次に開く選択画面には「フォルダ」しか表示されず、中のファイル（.txtや.mdなど）は表示されません。\n\n「ファイルが入っているフォルダ」自体を選択して、右下の『フォルダーの選択』を押してください。");
      }

      const allChunks = [];
      const loadedNames = [];

      // ② Vault認識済みフラグを渡して再帰ディレクトリ探索
      await processDirectory(dirHandle, allChunks, loadedNames, isVault);

      if (isVault) {
        console.log('[RAG] Obsidian Vaultを自動検出しました。WikiLink・YAML frontmatterを自動除去します。');
      }

      if (allChunks.length === 0) {
        alert("対応するテキストベースのファイルが見つかりませんでした。");
        setDocsLoading(false);
        return;
      }

      // DBを初期化（前回のゴミが残らないように確実に消す）
      await clearDB();

      // 制限: 最長100チャンク分だけをAPIに投げる (約10万文字分)
      const minifiedChunks = allChunks.slice(0, 100);
      const textsToEmbed = minifiedChunks.map(c => c.text);

      // OpenAIではなくGeminiのEmbeddings APIを使う
      const embeddings = await getGeminiEmbeddingsAct(textsToEmbed);

      if (!embeddings) {
        alert("Embeddingsの取得に失敗しました。APIキーの設定を確認してください。");
        setDocsLoading(false);
        return;
      }

      const embeddedDocs = minifiedChunks.map((chunk, i) => ({
        ...chunk,
        embedding: embeddings[i]
      }));

      // State(メモリ)の代わりに、IndexedDBのハードディスク領域へ一気に書き込む
      await putDocsToDB(embeddedDocs);

      setLoadedFileNames(loadedNames);
      alert(`合計 ${loadedNames.length} ファイルから ${embeddedDocs.length} 個のデータをベクトル化し、セキュアDB(IndexedDB)へ保存しました。`);

    } catch (err) {
      console.error(err);
      if (err.name !== 'AbortError') {
        alert("フォルダ読み込み中にエラーが発生しました。");
      }
    } finally {
      setDocsLoading(false);
    }
  }

  // --- メインプロンプト生成 ---
  async function generateOptimized() {
    if (!intent.trim() && !currentPrompt.trim()) return;
    setGenLoading(true);
    setOutput(null);
    const tagStr = [...selectedTags].join("、");

    // 【スナップショット保存】
    // この時点のcurrentPromptを「元の指示」として記録する。
    // 以降、ユーザーがcurrentPromptに追記した部分が「追加指示」として自動検出される。
    setOriginalPromptSnapshot(currentPrompt);

    const tagsStr = Array.from(selectedTags).join("、");
    
    // Few-shotデータの準備
    const fewShots = history
      .filter(h => selectedFewShotIds.has(h.id))
      .map(h => h.optimized);

    const res = await generateOptimizedAct(intent, currentPrompt, tagsStr, fewShots);
    setExecutionResult(""); // 新しいプロンプトを生成した場合は実行結果をクリア

    if (res && res.success) {
      const parsed = res.data;
      setOutput(parsed);
      const updated = [
        {
          id: Date.now(),
          intent,
          original: currentPrompt,
          optimized: parsed.optimized,
          tags: tagStr,
          reasons: parsed.reasons || [],
          tips: parsed.tips || "",
          time: new Date().toLocaleString("ja-JP"),
        },
        ...history,
      ].slice(0, 20);
      setHistory(updated);
    } else {
      setOutput({ error: true, errorMsg: res?.error || "不明なエラー", stack: res?.stack });
    }
    setGenLoading(false);
  }

  // --- Geminiで実行 ---
  async function executeWithGemini() {
    if (!output || !output.optimized) return;
    setExecutionLoading(true);
    setExecutionResult("");

    // ① 最適化されたプロンプトを起点に、ローカルフォルダ内の関連文章をRAG検索！
    let ragTexts = [];
    // メモリ(State)ではなくDBから直接読み出す
    const savedDocs = await getAllDocsFromDB();

    if (savedDocs && savedDocs.length > 0) {
      // 検索用クエリのベクトル化もGeminiで行う
      const queryEmbeds = await getGeminiEmbeddingsAct([output.optimized]);

      if (queryEmbeds && queryEmbeds.length > 0 && queryEmbeds[0]) {
        const queryVec = queryEmbeds[0];

        // 全チャンクと質問のコサイン類似度を比較
        const scoredDocs = savedDocs.map(doc => ({
          ...doc,
          score: cosineSimilarity(queryVec, doc.embedding)
        }));

        // 関連性が高い順に上位5チャンクを抽出
        scoredDocs.sort((a, b) => b.score - a.score);
        ragTexts = scoredDocs.slice(0, 5).map(d => d.text);
      }
    }


    // ② ユーザーが手動編集した「下書き (ragReasoning)」を禁止事項として渡しつつ、RAG情報を渡して実行

    // ③ 【追記部分の自動検出】
    let userAdditions = "";
    if (currentPrompt.trim() !== originalPromptSnapshot.trim()) {
      if (currentPrompt.startsWith(originalPromptSnapshot)) {
        userAdditions = currentPrompt.slice(originalPromptSnapshot.length).trim();
      } else {
        userAdditions = currentPrompt.trim();
      }
    }

    // ─── 実行前に最終プロンプトの「完成形」をUI表示用に組み立てる ───
    const ragContext = (ragTexts && ragTexts.length > 0)
      ? `\n\n【参考情報 (RAG)】\n以下のローカルファイルの関連情報を参考に回答を組み立ててください：\n${ragTexts.join("\n\n---\n\n")}\n`
      : "";
    const userDirectiveBlock = userAdditions.trim()
      ? `\n\n═══════════════════════════════════════\n【最優先：ユーザーからの直接指示】\n${userAdditions.trim()}\n═══════════════════════════════════════\n`
      : "";
    const forbiddenPrompt = ragReasoning.trim()
      ? `\n\n═══════════════════════════════════════\n【厳守：禁止条件・Not変数】\n${ragReasoning.trim()}\n═══════════════════════════════════════`
      : "";

    const fullPromptForDisplay = `（システム指示略）\n\n▼▼実行用プロンプト（土台）▼▼\n${output.optimized}\n▲▲▲▲${ragContext}${userDirectiveBlock}${forbiddenPrompt}`;
    setFinalPromptPreview(fullPromptForDisplay);
    // ────────────────────────────────────────────────────────────

    // Few-shotデータの準備
    const fewShots = history
      .filter(h => selectedFewShotIds.has(h.id))
      .map(h => h.optimized);

    const res = await executePromptAct(output.optimized, ragReasoning, ragTexts, userAdditions, fewShots);

    setExecutionResult(res);
    setExecutionLoading(false);

    // ① 自動的にマイプロンプト集へ保存（テンプレート化）
    (async () => {
      const template = await templatizePromptAct(output.optimized);
      const newPrompt = {
        id: Date.now(),
        title: intent.slice(0, 20) || "無題のプロンプト",
        content: template,
        createdAt: new Date().toLocaleString("ja-JP")
      };
      setMyPrompts(prev => {
        const updated = [newPrompt, ...prev].slice(0, 50);
        return updated;
      });
    })();
  }

  function handleSelectMyPrompt(id) {
    const target = myPrompts.find(p => p.id === id);
    if (!target) return;

    if (selectedMyPromptId === id) {
      setSelectedMyPromptId(null);
    } else {
      setSelectedMyPromptId(id);
      // 「プロンプト入力」タブに戻った時に反映されるようにするが、ここでは即時追加
      setCurrentPrompt(prev => prev + (prev.trim() ? "\n\n" : "") + target.content);
      setTab("input"); // 入力タブへ戻す
    }
  }

  const lblStyle = { fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 8, marginTop: 16, letterSpacing: "0.04em", display: "block", fontWeight: 500 };

  return (
    <main style={{ minHeight: "100vh", display: "flex", justifyContent: "center", padding: "3rem 1rem" }}>
      <div style={{ width: "100%", maxWidth: 720 }} className="animate-in">

        {/* Header */}
        <div style={{ marginBottom: "2.5rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "2.2rem", fontWeight: 800, margin: 0, background: "linear-gradient(135deg, #60a5fa 0%, #a78bfa 100%)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
            Gemini Prompt Generator
          </h1>
          <p style={{ color: "var(--color-text-secondary)", marginTop: "0.5rem", fontSize: 15 }}>
            AIがあなたのプロンプトを分析し、より的確な指示文へ最適化します。
          </p>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 8, marginBottom: "1.5rem" }}>
          {[
            ["input", "プロンプト入力"],
            ["my", "マイプロンプト集"],
            ["history", "履歴"],
            ["diff", "差分・分析"],
            ["help", "優先度ヘルプ"],
          ].map(([id, name]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`tab-btn ${tab === id ? "active" : ""}`}
            >
              {name}
              {id === "my" && myPrompts.length > 0 && (
                <span style={{ marginLeft: 6, fontSize: 10, background: "rgba(255,255,255,0.2)", padding: "2px 6px", borderRadius: 10 }}>
                  {myPrompts.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* INPUT TAB */}
        {tab === "input" && (
          <div className="animate-in">

            {/* ═══ Vault接続バナー（常時表示） ═══ */}
            <div style={{
              marginBottom: "1.5rem",
              padding: "0.875rem 1.25rem",
              borderRadius: 10,
              background: loadedFileNames.length > 0
                ? "linear-gradient(135deg, rgba(16,185,129,0.15) 0%, rgba(5,150,105,0.1) 100%)"
                : "rgba(255,255,255,0.04)",
              border: loadedFileNames.length > 0
                ? "1px solid rgba(16,185,129,0.4)"
                : "1px dashed rgba(255,255,255,0.15)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
              transition: "all 0.3s"
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 22 }}>📒</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: loadedFileNames.length > 0 ? "#6ee7b7" : "#94a3b8" }}>
                    {loadedFileNames.length > 0
                      ? `Obsidian 接続済み — ${loadedFileNames.length} ファイル`
                      : "Obsidian を接続して自分情報を取り込む"}
                  </div>
                  <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
                    {loadedFileNames.length > 0
                      ? `${loadedFileNames.slice(0, 3).join("  /  ")}${loadedFileNames.length > 3 ? ` …他${loadedFileNames.length - 3}件` : ""}`
                      : "接続するとノートの内容をRAGで自動参照します"}
                  </div>
                </div>
              </div>
              <button
                onClick={loadDirectoryFiles}
                disabled={docsLoading}
                style={{
                  fontSize: 12,
                  padding: "7px 16px",
                  borderRadius: 6,
                  background: loadedFileNames.length > 0
                    ? "rgba(16,185,129,0.25)"
                    : "rgba(96,165,250,0.2)",
                  border: loadedFileNames.length > 0
                    ? "1px solid rgba(16,185,129,0.5)"
                    : "1px solid rgba(96,165,250,0.4)",
                  color: loadedFileNames.length > 0 ? "#6ee7b7" : "#bfdbfe",
                  cursor: docsLoading ? "wait" : "pointer",
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                  transition: "all 0.2s"
                }}
                onMouseOver={(e) => e.currentTarget.style.opacity = "0.8"}
                onMouseOut={(e) => e.currentTarget.style.opacity = "1"}
              >
                {docsLoading ? <><Spinner /> 読み込み中…</> : loadedFileNames.length > 0 ? "🔄 再接続" : "📂 フォルダを選択"}
              </button>
            </div>
            {/* ══════════════════════════════════════ */}

            <span style={lblStyle}>やりたいこと（目的）</span>
            <div className="glass-card" style={{ padding: "1rem 1.25rem" }}>
              <textarea
                className="textarea-custom"
                style={{ minHeight: 64 }}
                value={intent}
                placeholder="例：コードのバグを直してほしい、文章を丁寧にしたい…"
                onChange={(e) => setIntent(e.target.value)}
              />
            </div>

            <span style={lblStyle}>今使っているプロンプト</span>
            <div className="glass-card" style={{ padding: "1rem 1.25rem" }}>
              <textarea
                className="textarea-custom"
                style={{ minHeight: 120 }}
                value={currentPrompt}
                placeholder="例：このコードのバグを直して。"
                onChange={(e) => setCurrentPrompt(e.target.value)}
              />
              {(selectedMyPromptId || selectedFewShotIds.size > 0) && (
                <div style={{ marginTop: 8, fontSize: 11, color: "#a78bfa", display: "flex", gap: 12 }}>
                  {selectedMyPromptId && <span>✨ マイプロンプト読込中</span>}
                  {selectedFewShotIds.size > 0 && <span>💜 Few-shot参照中 ({selectedFewShotIds.size}件)</span>}
                </div>
              )}
            </div>

            <span style={lblStyle}>
              重視したい観点
              {tagsLoading && (
                <span style={{ marginLeft: 12, fontSize: 11, color: "var(--color-accent)" }}>
                  <Spinner /> 自動分析中…
                </span>
              )}
            </span>
            <div className="glass-card" style={{ padding: "1rem" }}>
              {tags.map((tag) => {
                const active = selectedTags.has(tag.label);
                return (
                  <div key={tag.label} className={`tag-group ${active ? "active" : ""}`}>
                    <button
                      onClick={() => toggleTag(tag.label)}
                      className="tag-btn-left"
                      title={tag.desc}
                    >
                      {tag.label}
                      <span style={{ fontSize: 10, opacity: 0.7, marginLeft: 6 }}>
                        {tag.desc}
                      </span>
                    </button>
                    <button
                      onClick={() => appendToCurrentPrompt(tag.label)}
                      className="tag-btn-right"
                      title="「いま使っているプロンプト」に追記"
                    >
                      ＋
                    </button>
                  </div>
                );
              })}

              {/* Not変数エリアは生成結果のセクションへ移動しました */}
            </div>

            <div style={{ marginTop: "2rem" }}>
              <button
                onClick={generateOptimized}
                disabled={genLoading || (!intent.trim() && !currentPrompt.trim())}
                className="primary-btn"
              >
                {genLoading ? (
                  <>
                    <Spinner />
                    AIが最適化中…
                  </>
                ) : (
                  btnLabel
                )}
              </button>
            </div>

            {output && !output.error && (
              <div className="animate-in" style={{ marginTop: "2.5rem" }}>
                {/* 最適化プロンプト表示（プレビューと編集の切り替え可能） */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16, marginBottom: 8 }}>
                  <span style={lblStyle}>✨ 最適化されたプロンプト</span>
                  <div style={{ display: "flex", background: "rgba(0,0,0,0.3)", borderRadius: 6, padding: 3 }}>
                    <button
                      onClick={() => setPromptPreview(true)}
                      style={{ padding: "4px 12px", fontSize: 11, borderRadius: 4, border: "none", cursor: "pointer", background: promptPreview ? "rgba(96, 165, 250, 0.2)" : "transparent", color: promptPreview ? "#bfdbfe" : "#94a3b8" }}
                    >自然言語プレビュー</button>
                    <button
                      onClick={() => setPromptPreview(false)}
                      style={{ padding: "4px 12px", fontSize: 11, borderRadius: 4, border: "none", cursor: "pointer", background: !promptPreview ? "rgba(96, 165, 250, 0.2)" : "transparent", color: !promptPreview ? "#bfdbfe" : "#94a3b8" }}
                    >テキスト編集</button>
                  </div>
                </div>

                <div className="glass-card" style={{ position: "relative", minHeight: "250px", padding: "1.5rem" }}>
                  {promptPreview ? (
                    <div className="markdown-body" style={{ width: "100%", fontSize: 14, lineHeight: 1.8, color: "#e2e8f0", overflowY: "auto", maxHeight: "400px" }}>
                      <ReactMarkdown>{output.optimized}</ReactMarkdown>
                    </div>
                  ) : (
                    <textarea
                      value={output.optimized}
                      onChange={(e) => setOutput({ ...output, optimized: e.target.value })}
                      style={{ width: "100%", minHeight: "350px", fontSize: 14, lineHeight: 1.6, background: "rgba(0,0,0,0.2)", color: "#bfdbfe", padding: "12px", border: "1px solid rgba(96, 165, 250, 0.4)", borderRadius: "6px", fontFamily: "inherit" }}
                    />
                  )}

                  <div style={{ position: "absolute", top: "0.5rem", right: "0.5rem" }}>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(output.optimized).then(() => alert("最適化プロンプトをコピーしました！"));
                      }}
                      style={{ padding: "6px 16px", fontSize: 12, borderRadius: 8, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff", cursor: "pointer", transition: "all 0.2s" }}
                      onMouseOver={(e) => e.target.style.background = "rgba(255,255,255,0.15)"}
                      onMouseOut={(e) => e.target.style.background = "rgba(255,255,255,0.08)"}
                    >
                      📝 コピーする
                    </button>
                  </div>
                </div>

                {output.reasons && output.reasons.length > 0 && (
                  <>
                    <span style={lblStyle}>💡 改善ポイント</span>
                    <div className="glass-card" style={{ padding: "1rem" }}>
                      {output.reasons.map((r, i) => (
                        <div key={i} style={{ borderLeft: "3px solid #10b981", paddingLeft: 12, marginBottom: 8, fontSize: 14, color: "#a7f3d0" }}>
                          {r}
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {output.tips && (
                  <>
                    <span style={lblStyle}>💭 AIからのアドバイス</span>
                    <div className="glass-card" style={{ padding: "1rem" }}>
                      <div style={{ borderLeft: "3px solid #3b82f6", paddingLeft: 12, fontSize: 14, color: "#bfdbfe" }}>
                        {output.tips}
                      </div>
                    </div>
                  </>
                )}

                {/* Not変数エリア (生成後に出現) */}
                <div className="animate-in" style={{ marginTop: "2rem", background: "rgba(0,0,0,0.2)", borderRadius: 8, padding: "1.5rem" }}>
                  <div style={{ marginBottom: 12 }}>
                    <span style={{ fontSize: 13, color: "#fca5a5" }}>
                      ⚠️ この目的で失敗しやすい・除外すべき項目を追加で設定しますか？
                      {notTagsLoading && <span style={{ marginLeft: 8 }}><Spinner /></span>}
                    </span>
                  </div>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {notTags.length > 0 ? notTags.map((tag) => {
                      const active = selectedNotTags.has(tag.label);
                      return (
                        <div key={tag.label} className={`tag-group ${active ? "active-negative" : ""}`}>
                          <button
                            onClick={() => toggleNotTag(tag.label)}
                            className="tag-btn-left"
                            style={active ? { background: "rgba(239, 68, 68, 0.2)", color: "#fca5a5", borderColor: "rgba(239,68,68,0.4)" } : {}}
                          >
                            {tag.label}
                          </button>
                        </div>
                      );
                    }) : null}
                  </div>

                  {/* RAG理由の下書きエリア (編集可能なテキストエリアに変更) */}
                  {selectedNotTags.size > 0 && (
                    <div className="animate-in" style={{ marginTop: "1.5rem", borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: "1rem" }}>
                      {ragLoading ? (
                        <span style={{ fontSize: 13, color: "#94a3b8" }}><Spinner /> 除外すべき理由の下書きを構成中...</span>
                      ) : (
                        <>
                          <span style={{ fontSize: 12, color: "#94a3b8", fontWeight: 500 }}>📝 除外の理由・禁止事項ルールの下書き（自由に修正できます）</span>

                          <textarea
                            value={ragReasoning}
                            onChange={(e) => setRagReasoning(e.target.value)}
                            style={{ display: "block", width: "100%", minHeight: "120px", marginTop: 8, padding: "12px", fontSize: 13, background: "rgba(0,0,0,0.4)", border: "1px solid rgba(96, 165, 250, 0.4)", color: "#bfdbfe", borderRadius: "6px", resize: "vertical", fontFamily: "inherit" }}
                          />

                          <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", marginTop: "10px" }}>
                            <button
                              onClick={() => {
                                navigator.clipboard.writeText(ragReasoning).then(() => alert("コピーしました！\nこれを .md ファイルとしてローカルに保存してください。"));
                              }}
                              style={{ fontSize: 12, padding: "6px 14px", borderRadius: 4, background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", cursor: "pointer", transition: "all 0.2s" }}
                              onMouseOver={(e) => e.target.style.background = "rgba(255,255,255,0.2)"}
                              onMouseOut={(e) => e.target.style.background = "rgba(255,255,255,0.1)"}
                            >
                              📋 下書きをコピー
                            </button>
                          </div>

                          {loadedFileNames.length > 0 && (
                            <div style={{ fontSize: 11, color: "#6ee7b7", marginTop: 12, padding: "6px 10px", background: "rgba(16, 185, 129, 0.1)", borderRadius: 6, display: "inline-block" }}>
                              ✓ {loadedFileNames.length} ファイル読み込み完了: {loadedFileNames.slice(0, 3).join(", ")}{loadedFileNames.length > 3 ? " など" : ""}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>

                {/* 追加: 最後にGeminiで直接実行する */}
                <div style={{ marginTop: "2.5rem", borderTop: "1px dashed rgba(255,255,255,0.2)", paddingTop: "2rem", textAlign: "center" }}>
                  <button
                    onClick={executeWithGemini}
                    disabled={executionLoading}
                    style={{ background: "linear-gradient(135deg, #10b981 0%, #059669 100%)", color: "white", padding: "12px 24px", borderRadius: 8, fontSize: 15, fontWeight: "bold", border: "none", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "8px", boxShadow: "0 4px 14px rgba(16, 185, 129, 0.4)", transition: "all 0.2s" }}
                    onMouseOver={(e) => e.currentTarget.style.transform = "scale(1.02)"}
                    onMouseOut={(e) => e.currentTarget.style.transform = "scale(1)"}
                  >
                    {executionLoading ? <Spinner /> : "🚀 作成したプロンプトをGeminiで実行（※下書きを禁止条件に適用）"}
                  </button>
                </div>

                {/* 生成ローディング中のプロンプト表示 */}
                {executionLoading && finalPromptPreview && (
                  <div className="animate-in" style={{ marginTop: "1.5rem", textAlign: "left" }}>
                    <span style={lblStyle}>📡 送信中の最終プロンプト構成</span>
                    <div className="glass-card" style={{ padding: "1rem", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.1)" }}>
                      <pre style={{ fontSize: 11, color: "#94a3b8", whiteSpace: "pre-wrap", margin: 0, lineHeight: 1.5 }}>
                        {finalPromptPreview}
                      </pre>
                      <div style={{ marginTop: 8, fontSize: 10, color: "#60a5fa", textAlign: "right" }}>
                        <Spinner /> Geminiの回答を待機中...
                      </div>
                    </div>
                  </div>
                )}

                {/* 実行結果の表示エリア */}
                {executionResult && (
                  <div className="animate-in" style={{ marginTop: "1.5rem", textAlign: "left" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <span style={{ ...lblStyle, marginBottom: 0 }}>🤖 Geminiの実行結果</span>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(executionResult).then(() => alert("実行結果をコピーしました！"));
                        }}
                        style={{ padding: "6px 16px", fontSize: 12, borderRadius: 8, background: "rgba(16, 185, 129, 0.2)", border: "1px solid rgba(16, 185, 129, 0.4)", color: "#6ee7b7", cursor: "pointer", transition: "all 0.2s" }}
                        onMouseOver={(e) => e.target.style.background = "rgba(16, 185, 129, 0.3)"}
                        onMouseOut={(e) => e.target.style.background = "rgba(16, 185, 129, 0.2)"}
                      >
                        📋 コピー
                      </button>
                    </div>
                    <div className="glass-card" style={{ padding: "1.5rem", border: "1px solid rgba(16, 185, 129, 0.5)", background: "rgba(16, 185, 129, 0.05)" }}>
                      <div className="markdown-body" style={{ fontSize: 14, lineHeight: 1.8, color: "#e2e8f0" }}>
                        <ReactMarkdown>{executionResult}</ReactMarkdown>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {output?.error && (
              <div className="glass-card" style={{ marginTop: "1.5rem", padding: "1.5rem", borderLeft: "4px solid #ef4444" }}>
                <p style={{ fontSize: 14, color: "#fca5a5", margin: 0 }}>エラーが発生しました。APIキーや通信状況をご確認の上、もう一度お試しください。</p>
                {output.errorMsg && <p style={{ fontSize: 12, color: "#fca5a5", marginTop: "1rem", whiteSpace: "pre-wrap" }}>詳細: {output.errorMsg}</p>}
                {output.stack && <pre style={{ fontSize: 10, color: "#fca5a5", overflowX: "auto", marginTop: "0.5rem" }}>{output.stack}</pre>}
              </div>
            )}
          </div>
        )}

        {/* MY PROMPTS TAB */}
        {tab === "my" && (
          <div className="animate-in">
            <span style={lblStyle}>保存済みのテンプレート集（自動保存）</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {myPrompts.length === 0 ? (
                <div className="glass-card" style={{ padding: "2rem", textAlign: "center", color: "var(--color-text-secondary)" }}>
                  まだ保存されたプロンプトがありません。「Geminiで実行」すると自動的にここに保存されます。
                </div>
              ) : (
                myPrompts.map((p) => (
                  <div key={p.id} className="glass-card" style={{ padding: "1rem", display: "flex", gap: 12, alignItems: "flex-start", border: selectedMyPromptId === p.id ? "1px solid #60a5fa" : "1px solid rgba(255,255,255,0.1)" }}>
                    <div style={{ paddingTop: 4 }}>
                      <input
                        type="checkbox"
                        checked={selectedMyPromptId === p.id}
                        onChange={() => handleSelectMyPrompt(p.id)}
                        style={{ width: 18, height: 18, cursor: "pointer" }}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <span style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>{p.title}</span>
                        <span style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>{p.createdAt}</span>
                      </div>
                      <pre style={{ fontSize: 12, color: "#94a3b8", whiteSpace: "pre-wrap", background: "rgba(0,0,0,0.2)", padding: 8, borderRadius: 4, maxHeight: 120, overflow: "auto", fontFamily: "inherit" }}>
                        {p.content}
                      </pre>
                      <div style={{ marginTop: 8, textAlign: "right" }}>
                        <button
                          onClick={() => {
                            setMyPrompts(prev => {
                              const updated = prev.filter(item => item.id !== p.id);
                              return updated;
                            });
                            if (selectedMyPromptId === p.id) setSelectedMyPromptId(null);
                          }}
                          style={{ fontSize: 11, color: "#ef4444", background: "none", border: "none", cursor: "pointer" }}
                        >
                          削除
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* HISTORY TAB */}
        {tab === "history" && (
          <div className="animate-in">
            <span style={lblStyle}>保存済みプロンプト履歴（最大3つ選んでFew-shotに設定可能）</span>
            <div className="glass-card" style={{ padding: "0.5rem" }}>
              {history.length === 0 ? (
                <p style={{ fontSize: 14, color: "var(--color-text-tertiary)", textAlign: "center", padding: "2rem 0", margin: 0 }}>
                  まだ履歴がありません
                </p>
              ) : (
                history.map((h, i) => {
                  const isSelected = selectedFewShotIds.has(h.id);
                  return (
                    <div
                      key={h.id}
                      className="history-item"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "12px",
                        borderBottom: "1px solid rgba(255,255,255,0.05)",
                        background: isSelected ? "rgba(167, 139, 250, 0.1)" : "transparent",
                        borderLeft: isSelected ? "4px solid #a78bfa" : "4px solid transparent",
                        transition: "all 0.2s"
                      }}
                      onClick={() => {
                        setSelectedFewShotIds(prev => {
                          const next = new Set(prev);
                          if (next.has(h.id)) {
                            next.delete(h.id);
                          } else if (next.size < 3) {
                            next.add(h.id);
                          } else {
                            alert("Few-shotは最大3つまで選択可能です。");
                          }
                          return next;
                        });
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        readOnly
                        style={{ width: 16, height: 16, cursor: "pointer", accentColor: "#a78bfa" }}
                      />
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ fontWeight: 500, color: isSelected ? "#ddd6fe" : "#e2e8f0", fontSize: 14 }}>
                            {(h.optimized || "").slice(0, 60)}
                            {(h.optimized || "").length > 60 ? "…" : ""}
                          </span>
                          <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 20, marginLeft: 6, background: "rgba(255, 255, 255, 0.05)", color: "var(--color-text-tertiary)" }}>
                            {h.time.split(" ")[1]}
                          </span>
                        </div>
                        <div style={{ fontSize: 11, color: isSelected ? "#a78bfa" : "var(--color-text-tertiary)", marginTop: 4 }}>
                          観点: {h.tags || "なし"}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            {history.length > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
                <button
                  onClick={() => setTab("input")}
                  style={{ fontSize: 13, color: "#a78bfa", background: "rgba(167, 139, 250, 0.1)", border: "1px solid rgba(167, 139, 250, 0.3)", padding: "6px 16px", borderRadius: 6, cursor: "pointer" }}
                >
                  設定を適用して入力へ戻る
                </button>
                <button
                  onClick={() => {
                    if (!confirm("すべての履歴を削除しますか？")) return;
                    localStorage.removeItem(STORAGE_KEY);
                    setHistory([]);
                    setSelectedFewShotIds(new Set());
                  }}
                  style={{ fontSize: 13, color: "#f87171", background: "none", border: "none", cursor: "pointer" }}
                >
                  履歴をクリア
                </button>
              </div>
            )}
          </div>
        )}

        {/* DIFF TAB */}
        {tab === "diff" && (
          <div className="animate-in">
            <span style={lblStyle}>差分・改善の軌跡</span>
            <div className="glass-card" style={{ padding: "1.5rem" }}>
              {history.length < 2 ? (
                <p style={{ fontSize: 14, color: "var(--color-text-tertiary)", textAlign: "center", padding: "1rem 0", margin: 0 }}>
                  プロンプトを2つ以上生成すると差分が表示されます
                </p>
              ) : (
                (() => {
                  const n = history[0], p = history[1];
                  const added = (n.tags || "").split("、").filter((t) => t && !(p.tags || "").includes(t));
                  const removed = (p.tags || "").split("、").filter((t) => t && !(n.tags || "").includes(t));
                  return (
                    <>
                      <div style={{ marginBottom: 20 }}>
                        <span style={{ fontSize: 13, color: "#94a3b8", display: "block", marginBottom: 8 }}>最新（#{history.length}） vs 1つ前（#{history.length - 1}）</span>
                        <div style={{ borderLeft: "3px solid #10b981", paddingLeft: 12, marginBottom: 12, fontSize: 14, color: "#d1fae5", background: "rgba(16, 185, 129, 0.05)", padding: "10px 12px", borderRadius: "0 8px 8px 0" }}>
                          <strong style={{ color: "#34d399", marginRight: 8 }}>新:</strong>
                          {(n.optimized || "").slice(0, 100)}…
                        </div>
                        <div style={{ borderLeft: "3px solid #ef4444", paddingLeft: 12, marginBottom: 16, fontSize: 14, color: "#fee2e2", background: "rgba(239, 68, 68, 0.05)", padding: "10px 12px", borderRadius: "0 8px 8px 0" }}>
                          <strong style={{ color: "#f87171", marginRight: 8 }}>旧:</strong>
                          {(p.optimized || "").slice(0, 100)}…
                        </div>
                      </div>

                      {added.length > 0 && <div style={{ fontSize: 14, color: "#a7f3d0", marginBottom: 8 }}>➕ 追加された観点: {added.join("、")}</div>}
                      {removed.length > 0 && <div style={{ fontSize: 14, color: "#fca5a5", marginBottom: 16 }}>➖ 外された観点: {removed.join("、")}</div>}

                      <div style={{ marginTop: 24, padding: "14px", background: "rgba(59, 130, 246, 0.1)", borderRadius: 10, color: "#bfdbfe", fontSize: 14, borderLeft: "3px solid #3b82f6" }}>
                        <strong style={{ display: "block", marginBottom: 6, color: "#60a5fa" }}>最新のアドバイス:</strong>
                        {n.tips || "特になし"}
                      </div>
                    </>
                  );
                })()
              )}
            </div>
          </div>
        )}

        {/* HELP TAB */}
        {tab === "help" && (
          <div className="animate-in">
            <span style={lblStyle}>プロンプト組み立ての優先順位</span>
            <div className="glass-card" style={{ padding: "1.5rem" }}>
              <div style={{ display: "flex", gap: 20 }}>
                {/* 垂直優先度インジケーター */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "space-between", padding: "10px 0" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8" }}>低</div>
                  <div style={{ flex: 1, width: 2, background: "linear-gradient(to bottom, #94a3b8, #f87171)", margin: "8px 0", position: "relative" }}>
                    <div style={{ position: "absolute", top: -4, left: -4, width: 0, height: 0, borderLeft: "5px solid transparent", borderRight: "5px solid transparent", borderBottom: "8px solid #94a3b8" }}></div>
                    <div style={{ position: "absolute", bottom: -4, left: -4, width: 0, height: 0, borderLeft: "5px solid transparent", borderRight: "5px solid transparent", borderTop: "8px solid #f87171" }}></div>
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#f87171" }}>高</div>
                </div>

                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
                {[
                  { title: "【土台】実行プロンプト", role: "全体のタスク定義（マイプロンプト/テンプレート）", pos: "一番最初（全指示のベース）", color: "#94a3b8" },
                  { title: "【知識】RAGコンテキスト", role: "回答の根拠となる事実データ（Obsidianからの情報）", pos: "土台の次", color: "#60a5fa" },
                  { title: "【形式】Few-shot", role: "「こんな風に答えてほしい」というスタイルガイド", pos: "知識の次（中間がベスト）", color: "#a78bfa" },
                  { title: "【最優先】ユーザー追加指示", role: "今この瞬間にユーザーが入力した「これだけはやって」という指示", pos: "末尾に近い場所", color: "#fbbf24" },
                  { title: "【絶対厳守】Not変数", role: "絶対にやってはいけない制約・除外ルール", pos: "一番最後（末尾：最強のアテンション）", color: "#f87171" },
                ].map((item, idx) => (
                  <div key={idx} style={{ padding: "12px", borderLeft: `4px solid ${item.color}`, background: "rgba(255,255,255,0.03)", borderRadius: "0 8px 8px 0" }}>
                    <div style={{ fontWeight: 600, color: item.color, fontSize: 14, marginBottom: 4 }}>{item.title}</div>
                    <div style={{ fontSize: 12, color: "#e2e8f0", marginBottom: 2 }}><span style={{ opacity: 0.6 }}>役割：</span>{item.role}</div>
                    <div style={{ fontSize: 11, color: "#94a3b8" }}><span style={{ opacity: 0.6 }}>位置：</span>{item.pos}</div>
                  </div>
                ))}
                </div>
              </div>

              <div style={{ marginTop: 20, padding: "12px", background: "rgba(167, 139, 250, 0.05)", borderRadius: 8, border: "1px solid rgba(167, 139, 250, 0.2)" }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#a78bfa", marginBottom: 6 }}>💡 なぜこの順序が良いのか？</div>
                <div style={{ fontSize: 12, color: "#cbd5e1", lineHeight: 1.6 }}>
                  <strong>・Few-shotは「中間」がベスト：</strong><br />
                  お手本を最後に置くとAIがその「内容」に引っ張られすぎます。中間が定石です。<br />
                  <strong>・Not変数をアンカー（錨）にする：</strong><br />
                  AIも「最後に言われたこと」を最も強く記憶します。禁止事項を末尾に置くことで、ルール違反を最小限に抑えます。
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
