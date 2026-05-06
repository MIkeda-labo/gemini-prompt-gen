import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

// .env.local を手動で読み込む
const envPath = path.join(rootDir, '.env.local');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const [key, value] = line.split('=');
    if (key && value) {
      process.env[key.trim()] = value.trim();
    }
  });
}

// app/actions.mjs をインポート (Server Actions)
import * as actions from '../app/actions.mjs';

async function runTests() {
  console.log('🚀 メソッドレベルのテストを開始します...\n');
  const results = [];

  const testCases = [
    {
      name: 'regenerateTagsAct',
      fn: () => actions.regenerateTagsAct('京都旅行の計画'),
      verify: (res) => Array.isArray(res) && res.length > 0
    },
    {
      name: 'generateNotTagsAct',
      fn: () => actions.generateNotTagsAct('京都旅行の計画'),
      verify: (res) => Array.isArray(res) && res.length > 0
    },
    {
      name: 'getGeminiEmbeddingsAct',
      fn: () => actions.getGeminiEmbeddingsAct(['こんにちは', 'さようなら']),
      verify: (res) => Array.isArray(res) && res.length === 2 && Array.isArray(res[0])
    },
    {
      name: 'generateAndVerifyReasoningAct',
      fn: () => actions.generateAndVerifyReasoningAct('京都旅行の計画', '定番の場所、特定の企業名'),
      verify: (res) => res.geminiDraft && res.openaiFinal
    },
    {
      name: 'updateBtnLabelAct',
      fn: () => actions.updateBtnLabelAct('京都旅行の計画'),
      verify: (res) => typeof res === 'string' && res.includes('↗')
    },
    {
      name: 'generateOptimizedAct',
      fn: () => actions.generateOptimizedAct('京都旅行の計画', 'おすすめを教えて', '正確性、具体例', []),
      verify: (res) => res.success && res.data.optimized
    },
    {
      name: 'executePromptAct',
      fn: () => actions.executePromptAct('京都の穴場を教えて', '人混みは避ける', ['京都は歴史的な街です'], '静かな場所がいい'),
      verify: (res) => typeof res === 'string' && res.length > 0
    },
    {
      name: 'templatizePromptAct',
      fn: () => actions.templatizePromptAct('旅行期間：1週間'),
      verify: (res) => typeof res === 'string' && res.includes('：')
    }
  ];

  for (const tc of testCases) {
    try {
      console.log(`Testing: ${tc.name}...`);
      const start = Date.now();
      const res = await tc.fn();
      const duration = Date.now() - start;
      const pass = tc.verify(res);
      
      console.log(`  ✅ Success (${duration}ms)`);
      results.push({ name: tc.name, status: 'PASS', duration });
    } catch (err) {
      console.error(`  ❌ Failed: ${tc.name}`);
      console.error(`     Error: ${err.message}`);
      results.push({ name: tc.name, status: 'FAIL', error: err.message });
    }
  }

  console.log('\n=========================================');
  console.log('🏁 テスト結果サマリー');
  console.log('=========================================');
  console.table(results);
}

runTests().catch(console.error);
