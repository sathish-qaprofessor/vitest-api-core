import path from 'node:path';
import fs from 'node:fs';

/**
 * Vitest globalSetup — runs ONCE before any test worker starts.
 *
 * Clears stale Allure result files from previous runs so the generated report
 * reflects only the current execution. Without this, allure-vitest appends new
 * result files alongside old ones, and Allure aggregates start/stop timestamps
 * across every accumulated run — producing a bogus wall-clock window (e.g. the
 * gap between two separate runs) and an incorrect END TIME.
 *
 * The `history/` folder is preserved so trend widgets keep working.
 */
export default function setup(): void {
  const resultsDir = path.resolve(__dirname, 'reports/allure-results');
  if (!fs.existsSync(resultsDir)) return;

  for (const entry of fs.readdirSync(resultsDir)) {
    if (entry === 'history') continue;
    fs.rmSync(path.join(resultsDir, entry), { recursive: true, force: true });
  }
}
