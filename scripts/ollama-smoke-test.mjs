import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const model = process.argv[2] ?? process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:7b';
const startedAt = Date.now();
const runDir = path.resolve(
  process.cwd(),
  '.tmp',
  'ai-smoke-tests',
  new Date().toISOString().replace(/[:.]/g, '-')
);

const systemPrompt =
  'Tu es un assistant de dev web. Reponds avec du code directement exploitable, concis et propre. Quand on te demande une page, fournis un fichier unique complet sans explication.';

/**
 * @typedef {string | string[]} SmokeRequirement
 */

const prompts = [
  {
    id: 'site-vitrine-cafe',
    title: 'Petit site vitrine',
    prompt:
      'Cree un petit site web vitrine responsive en un seul fichier index.html pour un cafe imaginaire. Inclus HTML, CSS et un peu de JS. Donne directement le code complet, sans explication.',
    requiredSnippets: ['<html', '</html>', '@media']
  },
  {
    id: 'landing-page-saas',
    title: 'Landing page SaaS',
    prompt:
      "Cree une landing page responsive en un seul fichier index.html pour un SaaS de gestion de projets. Il faut un hero, trois features, un bloc tarifs et un bouton d'appel a l'action. Donne uniquement le code.",
    requiredSnippets: ['<html', 'hero', ['tarif', 'pricing', 'plan']]
  },
  {
    id: 'portfolio-developpeur',
    title: 'Portfolio developpeur',
    prompt:
      "Cree un portfolio developpeur responsive en un seul fichier index.html avec sections profil, projets, competences et contact. Ajoute un petit bouton JS pour changer de theme. Donne uniquement le code.",
    requiredSnippets: ['<html', 'contact', '<script']
  },
  {
    id: 'page-evenement',
    title: 'Page evenement',
    prompt:
      "Cree une page evenement responsive en un seul fichier index.html pour une conference tech. Il faut programme, speakers, FAQ et inscription. Donne uniquement le code.",
    requiredSnippets: ['<html', 'FAQ', 'speakers']
  },
  {
    id: 'dashboard-analytics',
    title: 'Dashboard analytics',
    prompt:
      "Cree un dashboard analytics responsive en un seul fichier index.html. Il faut une sidebar, des cartes stats, une section activity et un bloc chart. Donne uniquement le code.",
    requiredSnippets: ['<html', 'sidebar', ['stats', 'card'], 'activity', 'chart']
  },
  {
    id: 'page-produit',
    title: 'Page produit',
    prompt:
      "Cree une page produit responsive en un seul fichier index.html pour un casque audio. Il faut une galerie, un bloc prix, une section avis et un bouton d'achat. Donne uniquement le code.",
    requiredSnippets: ['<html', ['galerie', 'gallery'], ['prix', 'price'], 'avis', ['button', 'buy-button']]
  },
  {
    id: 'formulaire-contact',
    title: 'Formulaire contact',
    prompt:
      "Cree une page formulaire de contact responsive en un seul fichier index.html avec nom, email, sujet, message et validation JavaScript simple. Donne uniquement le code.",
    requiredSnippets: ['<html', '<form', 'email', 'message', '<script']
  },
  {
    id: 'todo-app',
    title: 'Todo app',
    prompt:
      "Cree une todo app responsive en un seul fichier index.html avec ajout, suppression et persistance localStorage. Donne uniquement le code.",
    requiredSnippets: ['<html', 'todo', 'localStorage', ['addEventListener', 'onclick']]
  }
];

await fs.mkdir(runDir, { recursive: true });

const results = [];

console.log(`Ollama smoke test`);
console.log(`Base URL: ${baseUrl}`);
console.log(`Model: ${model}`);
console.log(`Output: ${runDir}`);
console.log('');

for (const entry of prompts) {
  const result = await runPrompt(entry);
  results.push(result);
  const status = result.ok ? 'PASS' : 'WARN';
  console.log(
    `[${status}] ${entry.title} | ${result.durationMs} ms | ${result.outputLength} chars | ${path.basename(result.outputPath)}`
  );
  if (result.missingSnippets.length > 0) {
    console.log(`  Missing checks: ${result.missingSnippets.join(', ')}`);
  }
}

const summary = {
  baseUrl,
  model,
  runDir,
  startedAt: new Date(startedAt).toISOString(),
  endedAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt,
  total: results.length,
  passed: results.filter((item) => item.ok).length,
  warned: results.filter((item) => !item.ok).length,
  results
};

const summaryPath = path.join(runDir, 'summary.json');
await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

console.log('');
console.log(`Summary written to ${summaryPath}`);
console.log(`Passed: ${summary.passed}/${summary.total}`);

async function runPrompt(entry) {
  const promptStartedAt = Date.now();
  const response = await postChat({
    model,
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: entry.prompt }
    ]
  });

  const content = (response.message?.content ?? '').trim();
  const outputPath = path.join(runDir, `${entry.id}.md`);
  await fs.writeFile(outputPath, `${content}\n`, 'utf8');

  const normalizedContent = content.toLowerCase();
  const missingSnippets = entry.requiredSnippets
    .filter((snippet) => !matchesRequirement(normalizedContent, snippet))
    .map(formatRequirement);

  return {
    id: entry.id,
    title: entry.title,
    durationMs: Date.now() - promptStartedAt,
    outputLength: content.length,
    outputPath,
    ok: missingSnippets.length === 0,
    missingSnippets
  };
}

/**
 * @param {string} normalizedContent
 * @param {SmokeRequirement} requirement
 */
function matchesRequirement(normalizedContent, requirement) {
  if (Array.isArray(requirement)) {
    return requirement.some((candidate) => normalizedContent.includes(candidate.toLowerCase()));
  }

  return normalizedContent.includes(requirement.toLowerCase());
}

/**
 * @param {SmokeRequirement} requirement
 */
function formatRequirement(requirement) {
  return Array.isArray(requirement) ? requirement.join(' | ') : requirement;
}

async function postChat(body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('request_timeout')), 5 * 60 * 1000);

  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`ollama_http_${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}
