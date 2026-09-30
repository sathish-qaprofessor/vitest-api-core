#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

// Report dir can be supplied as a CLI argument or REPORT_DIR; default to the
// consumer project's conventional reports/allure-report location.
// CSS stays inside this package (resolved via __dirname).
const projectRoot = process.cwd();
const configuredReportDir = process.argv[2] || process.env.REPORT_DIR;
const reportDir = configuredReportDir
  ? path.resolve(projectRoot, configuredReportDir)
  : path.join(projectRoot, 'reports', 'allure-report');
// Results dir defaults to the report's sibling allure-results, but can be set
// explicitly (2nd CLI arg or ALLURE_RESULTS_DIR) for downloaded-artifact layouts.
const configuredResultsDir = process.argv[3] || process.env.ALLURE_RESULTS_DIR;
const resultsDir = configuredResultsDir
  ? path.resolve(projectRoot, configuredResultsDir)
  : path.join(path.dirname(reportDir), 'allure-results');
const customCss = path.join(__dirname, '..', 'reports', 'allure-custom.css');
const indexHtml  = path.join(reportDir, 'index.html');

if (!fs.existsSync(indexHtml)) {
  console.error('Allure report not found. Run allure generate first.');
  process.exit(1);
}

// ── Read widget data at build-time and embed into report ──────────────────────
const summary = JSON.parse(fs.readFileSync(path.join(reportDir, 'widgets', 'summary.json'), 'utf8'));

const stat          = summary.statistic;
const totalTests    = stat.total;
const passed        = stat.passed;
const failed        = stat.failed + (stat.broken || 0); // broken counts as failed
const skipped       = stat.skipped;
const sumDurationMs = summary.time.sumDuration;
const runStartMs    = summary?.time?.start || 0;
const runEndMs      = summary?.time?.stop || 0;

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const parts = [];
  if (hours > 0) parts.push(hours + 'h');
  if (mins > 0 || hours > 0) parts.push(mins + 'm');
  parts.push(secs + 's');
  return parts.join(' ');
}

function fmtDurationLong(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const parts = [];
  if (hours > 0) parts.push(hours + (hours === 1 ? ' hour' : ' hours'));
  if (mins > 0 || hours > 0) parts.push(mins + (mins === 1 ? ' min' : ' mins'));
  parts.push(secs + (secs === 1 ? ' sec' : ' secs'));
  return parts.join(' ');
}

function fmtDateTime(epochMs) {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return '-';
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return '-';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return yyyy + '-' + mm + '-' + dd + ' ' + hh + ':' + mi + ':' + ss;
}

const metrics = JSON.stringify({
  totalTests, passed, failed, skipped,
  executionTime: fmtDuration(sumDurationMs),
  elapsedTime: fmtDuration(Math.max(0, runEndMs - runStartMs)),
  executionTimeLong: fmtDurationLong(sumDurationMs),
  elapsedTimeLong: fmtDurationLong(Math.max(0, runEndMs - runStartMs)),
  passRate: totalTests > 0 ? ((passed / totalTests) * 100).toFixed(1) : '0.0',
  startTime: fmtDateTime(runStartMs),
  endTime: fmtDateTime(runEndMs),
});

// ── Aggregate test metrics grouped by spec/test file ──────────────────────
// Extract the spec file name for a raw allure result. Prefer `fullName`
// ("path/to/file.test.ts#suite > test") whose portion before '#' is the file
// path; fall back to titlePath entries or the `package` label.
function extractSpecFile(result) {
  const fullName = typeof result.fullName === 'string' ? result.fullName : '';
  if (fullName) {
    const beforeHash = fullName.split('#')[0].trim();
    if (beforeHash) {
      const base = beforeHash.split(/[\\/]/).pop();
      if (base) return base;
    }
  }

  if (Array.isArray(result.titlePath)) {
    const fileEntry = result.titlePath.find(function(p) {
      return typeof p === 'string' && /\.(test|spec)\.[cm]?[jt]sx?$/i.test(p);
    });
    if (fileEntry) return fileEntry.split(/[\\/]/).pop();
  }

  const labels = Array.isArray(result.labels) ? result.labels : [];
  const pkg = labels.find(function(label) { return label?.name === 'package'; });
  if (pkg?.value) return pkg.value;

  return 'Unknown Spec File';
}

function loadSpecFileRows() {
  const rowsByFile = new Map();
  if (!fs.existsSync(resultsDir)) return [];

  const files = fs.readdirSync(resultsDir).filter(function(file) {
    return file.endsWith('-result.json');
  });

  files.forEach(function(file) {
    try {
      const result = JSON.parse(fs.readFileSync(path.join(resultsDir, file), 'utf8'));
      const specFile = extractSpecFile(result);

      if (!rowsByFile.has(specFile)) {
        rowsByFile.set(specFile, { name: specFile, total: 0, passed: 0, failed: 0 });
      }

      const row = rowsByFile.get(specFile);
      row.total += 1;

      const status = result.status || '';
      if (status === 'passed') {
        row.passed += 1;
      } else if (status === 'failed' || status === 'broken') {
        row.failed += 1;
      }
    } catch {
      // Malformed result files are skipped so remaining spec files still render.
    }
  });

  return Array.from(rowsByFile.values()).sort(function(a, b) {
    return b.total - a.total || a.name.localeCompare(b.name);
  });
}

const specFilesData = JSON.stringify(loadSpecFileRows());

// ── Reclassify broken → failed in allure-results source files ──────────────
const allureResultsDir = resultsDir;
if (fs.existsSync(allureResultsDir)) {
  fs.readdirSync(allureResultsDir)
    .filter(function(f) { return f.endsWith('-result.json'); })
    .forEach(function(file) {
      const fp = path.join(allureResultsDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (data.status === 'broken') {
          data.status = 'failed';
          fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8');
        }
      } catch {
        // Result patching is best-effort and must not prevent report generation.
      }
    });
}

// ── Reclassify broken → failed in the generated report data ───────────────
function patchObj(obj, pathParts) {
  pathParts = Array.isArray(pathParts) ? pathParts : [];
  if (Array.isArray(obj)) return obj.map(function(item) { return patchObj(item, pathParts); });
  if (obj && typeof obj === 'object') {
    const out = {};
    const isNestedStep = pathParts.includes('steps');
    Object.keys(obj).forEach(function(k) {
      if (k === 'status' && obj[k] === 'broken') {
        out[k] = isNestedStep ? 'broken' : 'failed';
      } else if (k === 'statistic' && obj[k] && typeof obj[k] === 'object') {
        const s = { ...obj[k] };
        s.failed = (s.failed || 0) + (s.broken || 0);
        s.broken = 0;
        out[k] = s;
      } else {
        out[k] = patchObj(obj[k], pathParts.concat(k));
      }
    });
    return out;
  }
  return obj;
}

function patchJsonFile(fp) {
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    if (!raw.includes('broken')) return;
    const patched = patchObj(JSON.parse(raw), []);
    fs.writeFileSync(fp, JSON.stringify(patched), 'utf8');
  } catch {
    // Generated files vary by Allure version; unsupported JSON is left unchanged.
  }
}

function patchDir(dir) {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir).forEach(function(entry) {
    const fp = path.join(dir, entry);
    if (fs.statSync(fp).isDirectory()) patchDir(fp);
    else if (entry.endsWith('.json')) patchJsonFile(fp);
  });
}

patchDir(path.join(reportDir, 'data'));
patchDir(path.join(reportDir, 'widgets'));

// ── Build CSS ─────────────────────────────────────────────────────────────────
const css = fs.readFileSync(customCss, 'utf8');

// ── Build JS embedded into the report ────────────────────────────────────────
const js = `
(function() {
  var METRICS = ${metrics};
  var SPEC_FILES_DATA = ${specFilesData};

  /* ── helpers ────────────────────────────────────────────────────── */
  function isOverview() {
    return location.hash === '' || location.hash === '#/' || location.hash === '#';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('allure-theme', theme);
    document.querySelectorAll('.theme-switcher button').forEach(function(b) {
      b.classList.toggle('active', b.getAttribute('data-theme') === theme);
    });
  }

  /* ── Theme switcher ─────────────────────────────────────────────── */
  var THEMES = ['solarized', 'dark-teal', 'light', 'dark'];
  var DEFAULT_THEME = 'solarized';
  function buildThemeSwitcher() {
    if (document.querySelector('.theme-switcher')) return;
    var switcher = document.createElement('div');
    switcher.className = 'theme-switcher';
    THEMES.forEach(function(theme) {
      var btn = document.createElement('button');
      btn.setAttribute('data-theme', theme);
      btn.title = theme.split('-').map(function(w) {
        return w.charAt(0).toUpperCase() + w.slice(1);
      }).join(' ') + ' mode';
      btn.addEventListener('click', function() { applyTheme(theme); });
      switcher.appendChild(btn);
    });
    document.body.appendChild(switcher);
    var stored = localStorage.getItem('allure-theme');
    applyTheme(THEMES.indexOf(stored) !== -1 ? stored : DEFAULT_THEME);
  }

  /* ── Metrics bar ────────────────────────────────────────────────── */
  function buildMetricsBar() {
    if (document.getElementById('custom-metrics-bar')) return;
    var bar = document.createElement('div');
    bar.id = 'custom-metrics-bar';
    bar.innerHTML =
      '<div class="cmb__card" title="Total Spec Files"><span class="cmb__val">' + SPEC_FILES_DATA.length + '</span><span class="cmb__lbl">Spec Files</span></div>' +
      '<div class="cmb__card" title="Total Tests"><span class="cmb__val">' + METRICS.totalTests + '</span><span class="cmb__lbl">Total Tests</span></div>' +
      '<div class="cmb__card cmb__passed" title="Passed"><span class="cmb__val">' + METRICS.passed + '</span><span class="cmb__lbl">Passed</span></div>' +
      '<div class="cmb__card cmb__failed" title="Failed"><span class="cmb__val">' + METRICS.failed + '</span><span class="cmb__lbl">Failed</span></div>' +
      '<div class="cmb__card cmb__skipped" title="Skipped"><span class="cmb__val">' + METRICS.skipped + '</span><span class="cmb__lbl">Skipped</span></div>' +
      '<div class="cmb__card cmb__duration" title="Sum of all individual test execution times: ' + METRICS.executionTimeLong + '"><span class="cmb__val">' + METRICS.executionTime + '</span><span class="cmb__lbl">Execution Time</span></div>' +
      '<div class="cmb__card cmb__duration" title="Elapsed time from the first test start to the last test finish: ' + METRICS.elapsedTimeLong + '"><span class="cmb__val">' + METRICS.elapsedTime + '</span><span class="cmb__lbl">Elapsed Time</span></div>' +
      '<div class="cmb__card cmb__time" title="First test start time"><span class="cmb__val">' + METRICS.startTime + '</span><span class="cmb__lbl">Run Started</span></div>' +
      '<div class="cmb__card cmb__time" title="Last test end time"><span class="cmb__val">' + METRICS.endTime + '</span><span class="cmb__lbl">Run Finished</span></div>' +
      '<div class="cmb__card cmb__rate" title="Pass rate"><span class="cmb__val">' + METRICS.passRate + '%</span><span class="cmb__lbl">Pass Rate</span></div>';
    return bar;
  }

  /* ── Custom Spec Files Table ────────────────────────────────────────── */
  function buildSpecFilesTable() {
    if (document.getElementById('custom-spec-files-table')) return null;
    var rows = SPEC_FILES_DATA.map(function(s) {
      var pct = s.total > 0 ? ((s.passed / s.total) * 100).toFixed(2) : '0.00';
      var failClass = s.failed > 0 ? ' cst__num--failed' : '';
      return '<tr class="cst__row">' +
        '<td class="cst__name" style="padding-left:10px"><span class="cst__link">' + s.name.toUpperCase() + '</span></td>' +
        '<td class="cst__num">' + s.total + '</td>' +
        '<td class="cst__num cst__num--passed">' + s.passed + '</td>' +
        '<td class="cst__num' + failClass + '">' + s.failed + '</td>' +
        '<td class="cst__pct">' + pct + '%</td>' +
        '</tr>';
    }).join('');
    var wrapper = document.createElement('div');
    wrapper.id = 'custom-spec-files-table';
    wrapper.className = 'widget island';
    wrapper.innerHTML =
      '<div class="widget__title">SPEC FILES' +
        '<span class="cst__count">' + SPEC_FILES_DATA.length + ' items total</span>' +
      '</div>' +
      '<div class="cst__table-wrapper">' +
        '<table class="cst__table">' +
          '<thead>' +
            '<tr>' +
              '<th class="cst__th cst__th--name">Spec File</th>' +
              '<th class="cst__th">Total</th>' +
              '<th class="cst__th">Passed</th>' +
              '<th class="cst__th">Failed</th>' +
              '<th class="cst__th">Pass %</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>' +
      '</div>';
    return wrapper;
  }

  function syncSummaryPassRate(summaryWidget) {
    if (!summaryWidget) return;
    var value = METRICS.passRate + '%';

    // SVG caption used by most Allure builds. Only write when different so we
    // never emit a needless DOM mutation (which would retrigger the observer).
    summaryWidget.querySelectorAll('text.chart__caption, .chart__caption').forEach(function(node) {
      if (node.textContent !== value) node.textContent = value;
    });

    // Fallback for caption split into tspans
    summaryWidget.querySelectorAll('tspan').forEach(function(node) {
      var txt = (node.textContent || '').trim();
      if (/^\\d+(\\.\\d+)?%$/.test(txt) && txt !== value) {
        node.textContent = value;
      }
    });
  }

  function isGraph() {
    return location.hash.indexOf('#graph') === 0;
  }

  // Allure's Graphs > Status donut computes its centre caption as
  // passed / (passed + failed + broken), excluding skipped tests. That differs
  // from our overview pass rate (passed / total). Override the caption so both
  // pages report the same value.
  function syncGraphPassRate() {
    var statusWidget = null;
    document.querySelectorAll('.widget').forEach(function(w) {
      var t = w.querySelector('.widget__title');
      if (t && /^status$/i.test((t.innerText || t.textContent || '').trim())) statusWidget = w;
    });
    if (statusWidget) syncSummaryPassRate(statusWidget);
  }

  /* ── Add passed/failed counts into the Allure summary widget ───────── */
  function injectSummaryStats(summaryWidget) {
    // Hide the time range line (second text node / subtitle element)
    summaryWidget.querySelectorAll(':scope > *').forEach(function(el) {
      if (!el.classList.contains('widget__title') &&
          !el.classList.contains('cmb__summary-stats') &&
          !el.querySelector('canvas') &&
          !el.querySelector('.chart') &&
          !el.querySelector('svg')) {
        var txt = el.innerText || el.textContent || '';
        if (/\\d{1,2}:\\d{2}/.test(txt)) el.style.display = 'none';
      }
    });
    // Center only the chart container inside the widget, leave title alone
    summaryWidget.querySelectorAll(':scope > *').forEach(function(el) {
      if (el.querySelector('canvas') || el.querySelector('svg') || el.querySelector('.chart')) {
        el.style.overflow = 'visible';
      }
    });
    if (summaryWidget.querySelector('.cmb__summary-stats')) return;
    var statsDiv = document.createElement('div');
    statsDiv.className = 'cmb__summary-stats';
    statsDiv.innerHTML =
      '<span class="cmb__summary-total"><span class="cmb__summary-dot cmb__dot-total"></span>' + METRICS.totalTests + ' Total Tests</span>' +
      '<span class="cmb__summary-passed"><span class="cmb__summary-dot cmb__dot-passed"></span>' + METRICS.passed + ' Passed</span>' +
      '<span class="cmb__summary-failed"><span class="cmb__summary-dot cmb__dot-failed"></span>' + METRICS.failed + ' Failed</span>' +
      '<span class="cmb__summary-skipped"><span class="cmb__summary-dot cmb__dot-skipped"></span>' + METRICS.skipped + ' Skipped</span>';
    summaryWidget.appendChild(statsDiv);
    syncSummaryPassRate(summaryWidget);
  }

  /* ── Hide any widget whose title text matches a pattern ─────────── */
  function hideWidgetsByTitle(titleRegex) {
    document.querySelectorAll('.widget').forEach(function(w) {
      var t = w.querySelector('.widget__title');
      if (t && titleRegex.test((t.innerText || t.textContent || '').trim())) {
        w.style.display = 'none';
      }
    });
  }

  /* ── Layout manipulation ─────────────────────────────────────────── */
  function applyOverviewLayout() {
    var grid = document.querySelector('.widgets-grid');
    var cols = document.querySelectorAll('.widgets-grid__col');
    if (!grid || cols.length < 2) return false;

    var rightCol = cols[1];

    // Inject full-width metrics bar at top of widgets-grid (before columns)
    if (!document.getElementById('custom-metrics-bar')) {
      var bar = buildMetricsBar();
      if (bar) grid.insertBefore(bar, grid.firstChild);
    }

    // Hide suites, behaviors, environment widgets via data-id + title text fallback
    var suitesWidget = document.querySelector('.widget[data-id="suites"]');
    if (suitesWidget) suitesWidget.style.display = 'none';

    var behaviorsWidget = document.querySelector('.widget[data-id="behaviors"]');
    if (behaviorsWidget) behaviorsWidget.style.display = 'none';

    var envWidget = document.querySelector('.widget[data-id="environment"]');
    if (envWidget) envWidget.style.display = 'none';
    hideWidgetsByTitle(/^environment$/i);

    var categoriesWidget = document.querySelector('.widget[data-id="categories"]');
    if (categoriesWidget) categoriesWidget.style.display = 'none';
    hideWidgetsByTitle(/^categories$/i);

    // Inject spec-file metrics table into right col, beside the pie chart panel
    if (!document.getElementById('custom-spec-files-table')) {
      var specTbl = buildSpecFilesTable();
      if (specTbl) rightCol.insertBefore(specTbl, rightCol.firstChild);
    }

    // Inject passed/failed into Allure summary widget
    var summaryWidget = document.querySelector('.widget[data-id="summary"]');
    if (summaryWidget) {
      injectSummaryStats(summaryWidget);
      syncSummaryPassRate(summaryWidget);
    }

    return true;
  }

  /* ── Remove injected custom elements so they can be re-injected ─── */
  function resetOverlayElements() {
    var bar = document.getElementById('custom-metrics-bar');
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    var specTbl = document.getElementById('custom-spec-files-table');
    if (specTbl && specTbl.parentNode) specTbl.parentNode.removeChild(specTbl);
    document.querySelectorAll('.cmb__summary-stats').forEach(function(el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
  }

  /* ── Observer: keeps watching so re-renders on tab navigation ────── */
  function watchForGrid() {
    var contentEl = document.getElementById('content');
    if (!contentEl) return;

    var mo;
    var scheduled = false;
    var observerConfig = { childList: true, subtree: true };

    function run() {
      scheduled = false;
      // Detach while we mutate the DOM. Our own inserts/text writes would
      // otherwise retrigger this observer, creating an infinite feedback loop
      // that pegs the main thread — freezing chart rendering and navigation.
      mo.disconnect();
      if (isOverview()) {
        applyOverviewLayout();
      } else {
        // Leaving overview — reset so elements are re-injected when returning
        resetOverlayElements();
        if (isGraph()) syncGraphPassRate();
      }
      mo.takeRecords(); // discard records generated by our own mutations
      mo.observe(contentEl, observerConfig);
    }

    // Debounce to one animation frame so bursts of Allure re-renders coalesce.
    mo = new MutationObserver(function() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(run);
    });
    mo.observe(contentEl, observerConfig);
  }

  /* ── Re-apply on hash navigation (SPA routing) ───────────────────── */
  window.addEventListener('hashchange', function() {
    if (isOverview()) {
      resetOverlayElements();
      var attempts = 0;
      var poll = setInterval(function() {
        if (applyOverviewLayout() || ++attempts > 40) clearInterval(poll);
      }, 100);
    } else if (isGraph()) {
      var gattempts = 0;
      var gpoll = setInterval(function() {
        syncGraphPassRate();
        if (++gattempts > 40) clearInterval(gpoll);
      }, 100);
    }
  });

  /* ── Force ascending sort (fix stored + intercept future writes) ─── */
  (function forceAscendingSort() {
    function patchAllureSettings(key, raw) {
      try {
        var v = JSON.parse(raw);
        if (v && v.treeSorting) { v.treeSorting.ascending = true; return JSON.stringify(v); }
      } catch (e) {}
      return raw;
    }
    // Fix any already-stored settings
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf('ALLURE_REPORT_SETTINGS_') === 0) {
        var existing = localStorage.getItem(k);
        var patched = patchAllureSettings(k, existing);
        if (patched !== existing) localStorage.setItem(k, patched);
      }
    }
    // Intercept future writes so user-clicks can't persist descending
    var _origSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key && key.indexOf('ALLURE_REPORT_SETTINGS_') === 0) {
        value = patchAllureSettings(key, value);
      }
      _origSet.call(this, key, value);
    };
  })();

  /* ── Boot ────────────────────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', function() {
    buildThemeSwitcher();
    watchForGrid();
    // If already on overview (direct load), try immediately then watch
    if (isOverview()) {
      var attempts = 0;
      var poll = setInterval(function() {
        if (applyOverviewLayout() || ++attempts > 30) clearInterval(poll);
      }, 100);
    }
  });
})();
`;


let html = fs.readFileSync(indexHtml, 'utf8');
html = html.replace('</head>', `<style>${css}</style>\n</head>`);
html = html.replace('</body>', `<script>${js}</script>\n</body>`);
fs.writeFileSync(indexHtml, html);
console.log('Custom CSS and JS injected into Allure report.');
