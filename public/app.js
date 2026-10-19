// Global Application State
let APP = {
  settings: {},
  currencies: [],
  accounts: [],
  kpis: {},
  monthlyTrends: [],
  monthExpenseBreakdown: [],
  ytdExpenseBreakdown: [],
  transactions: [],
  budgets: [],
  savingsGoals: [],
  invoicesBills: [],
  recurring: [],
  rules: [],
  importBatches: [],
  backups: [],
  activeTab: 'dashboard',
  txViewMode: 'SIMPLE', // 'SIMPLE' or 'JOURNAL'
  coaFilter: 'ALL',
  activeReportTab: 'pnl',
  reportsData: null,
  csvRawText: '',
  csvFilename: 'bank_statement.csv',
  csvPreviewData: null,
  reconcileData: null
};

let cashFlowChartInstance = null;
let expenseDonutChartInstance = null;

// Currency formatter
function fmtMoney(amount, currencyCode = null) {
  const code = currencyCode || APP.settings.base_currency || 'USD';
  const currObj = APP.currencies.find((c) => c.code === code);
  const symbol = currObj ? currObj.symbol : '$';
  const num = Number(amount) || 0;
  const isNeg = num < -0.004;
  const absStr = Math.abs(num).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  return isNeg ? `-${symbol}${absStr}` : `${symbol}${absStr}`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  const bg = type === 'error' ? 'bg-rose-600' : 'bg-slate-900 border border-emerald-500/40';
  el.className = `${bg} text-white px-4 py-3 rounded-xl shadow-lg text-xs font-medium flex items-center gap-2.5 transition-all`;
  el.innerHTML = `
    <span class="w-2 h-2 rounded-full ${type === 'error' ? 'bg-white' : 'bg-emerald-400'}"></span>
    <span>${escapeHtml(message)}</span>
  `;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 3800);
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

// Bootstrap & Refresh All State
async function loadBootstrap() {
  try {
    const data = await apiFetch('/api/bootstrap');
    Object.assign(APP, data);

    // Header & Sidebar badges
    document.getElementById('brandOrgName').textContent = APP.settings.organization_name || 'Personal Ledger Pro';
    const baseCode = APP.settings.base_currency || 'USD';
    const baseCurr = APP.currencies.find((c) => c.code === baseCode);
    document.getElementById('baseCurrencyBadge').textContent = `Base: ${baseCode} (${baseCurr ? baseCurr.symbol : '$'})`;
    document.getElementById('navTxCount').textContent = APP.transactions.length;

    const openDocs = APP.invoicesBills.filter((d) => d.status === 'OPEN').length;
    document.getElementById('navOpenDocsCount').textContent = openDocs;

    const balBadge = document.getElementById('sidebarBalancedBadge');
    if (APP.kpis.isBooksBalanced) {
      balBadge.textContent = 'BALANCED';
      balBadge.className = 'px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-300';
    } else {
      balBadge.textContent = 'CHECK LEDGER';
      balBadge.className = 'px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-500/20 text-rose-300';
    }

    populateAccountSelectors();
    renderDashboard();
    renderTransactionsView();
    renderImportExportView();
    if (APP.csvPreviewData) renderCSVPreviewUI();
    renderCOAView();
    renderRulesList();
    renderBudgetsAndGoals();
    renderInvoicesAndRecurring();
    renderSettingsView();

    if (APP.activeTab === 'reconcile') {
      loadReconciliationWorkspace();
    } else if (APP.activeTab === 'reports') {
      loadAndRenderReports();
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Navigation Tab Switching
const TAB_TITLES = {
  dashboard: 'Executive Financial Dashboard',
  transactions: 'Transactions Register & Double-Entry General Journal',
  'import-export': 'Bank Statement Import (.CSV) & Data Export Center',
  accounts: 'Chart of Accounts & General Ledger',
  reconcile: 'Bank Reconciliation & Auto-Categorization Rules',
  reports: 'Financial Statements & Tax Reports Suite',
  budgets: 'Monthly Budgets & Savings Goals',
  invoices: 'Invoices (AR), Bills (AP) & Recurring Schedule',
  settings: 'Multi-Currency & Accounting Preferences'
};

function switchTab(tabId) {
  APP.activeTab = tabId;
  document.querySelectorAll('.tab-view').forEach((el) => el.classList.add('hidden'));
  const target = document.getElementById(`view-${tabId}`);
  if (target) target.classList.remove('hidden');

  document.querySelectorAll('#sidebarNav .nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  document.getElementById('pageTitle').textContent = TAB_TITLES[tabId] || 'QuickBooks Personal Pro';

  if (tabId === 'reconcile') {
    loadReconciliationWorkspace();
  } else if (tabId === 'reports') {
    loadAndRenderReports();
  }
}

// Populate Dropdowns across Forms & Filters
function populateAccountSelectors() {
  const bankAndCardAccounts = APP.accounts.filter((a) =>
    ['BANK', 'CREDIT_CARD', 'INVESTMENT'].includes(a.subtype)
  );

  // Transaction filter
  const txFilter = document.getElementById('txAccountFilter');
  const currentFilterVal = txFilter.value;
  txFilter.innerHTML = `<option value="">All Accounts (${APP.accounts.length})</option>` +
    APP.accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.code)} - ${escapeHtml(a.name)} (${a.type})</option>`).join('');
  txFilter.value = currentFilterVal;

  // CSV Import Target Account (All Asset & Liability accounts first, then all accounts so any ledger can be uploaded)
  const impSelect = document.getElementById('importTargetAccount');
  const curImp = impSelect.value;
  const primaryUploadAccounts = APP.accounts.filter((a) => ['ASSET', 'LIABILITY', 'EQUITY'].includes(a.type));
  impSelect.innerHTML = primaryUploadAccounts.map((a) =>
    `<option value="${a.id}">${escapeHtml(a.code)} - ${escapeHtml(a.name)} (${a.subtype || a.type} • ${fmtMoney(a.balance)})</option>`
  ).join('');
  if (curImp) impSelect.value = curImp;

  // Reconcile Account Select
  const recSelect = document.getElementById('reconcileAccountSelect');
  const curRec = recSelect.value;
  recSelect.innerHTML = bankAndCardAccounts.map((a) =>
    `<option value="${a.id}">${escapeHtml(a.code)} - ${escapeHtml(a.name)} (${a.subtype})</option>`
  ).join('');
  if (curRec) recSelect.value = curRec;

  // Rule Target Account
  const ruleTarget = document.getElementById('ruleTargetAccount');
  ruleTarget.innerHTML = APP.accounts
    .filter((a) => ['EXPENSE', 'INCOME', 'ASSET', 'LIABILITY'].includes(a.type))
    .map((a) => `<option value="${a.id}">${escapeHtml(a.code)} - ${escapeHtml(a.name)}</option>`)
    .join('');

  // Budget Account Select
  const budgetSelect = document.getElementById('budgetAccountSelect');
  budgetSelect.innerHTML = APP.accounts
    .filter((a) => a.type === 'EXPENSE')
    .map((a) => `<option value="${a.id}">${escapeHtml(a.code)} - ${escapeHtml(a.name)}</option>`)
    .join('');

  // Recurring selectors
  document.getElementById('recPaymentAcc').innerHTML = bankAndCardAccounts
    .map((a) => `<option value="${a.id}">${escapeHtml(a.code)} - ${escapeHtml(a.name)}</option>`)
    .join('');
  document.getElementById('recCategoryAcc').innerHTML = APP.accounts
    .map((a) => `<option value="${a.id}">${escapeHtml(a.code)} - ${escapeHtml(a.name)} (${a.type})</option>`)
    .join('');

  // Currency selector in Simple Modal
  document.getElementById('simpleTxCurrency').innerHTML = APP.currencies
    .map((c) => `<option value="${c.code}">${c.code} (${c.symbol})</option>`)
    .join('');

  populateInvoiceBillAccounts();
}

function populateInvoiceBillAccounts() {
  const docType = document.getElementById('docType')?.value || 'INVOICE';
  const targetType = docType === 'INVOICE' ? 'INCOME' : 'EXPENSE';
  const sel = document.getElementById('docCategoryAccount');
  if (!sel) return;
  sel.innerHTML = APP.accounts
    .filter((a) => a.type === targetType)
    .map((a) => `<option value="${a.id}">${escapeHtml(a.code)} - ${escapeHtml(a.name)}</option>`)
    .join('');
}

// ================= 1. DASHBOARD RENDERING =================
function renderDashboard() {
  const k = APP.kpis;
  const kpiGrid = document.getElementById('dashboardKpiGrid');
  kpiGrid.innerHTML = `
    <div class="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
      <div class="flex items-center justify-between text-xs text-slate-500 font-medium">
        <span>Total Net Worth</span>
        <span class="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 font-mono text-[10px]">Assets - Liab</span>
      </div>
      <div class="text-xl font-bold font-mono text-slate-900 mt-1.5">${fmtMoney(k.netWorth)}</div>
      <div class="text-[11px] text-slate-500 mt-1">Assets: ${fmtMoney(k.totalAssets)} | Debt: ${fmtMoney(k.totalLiabilities)}</div>
    </div>

    <div class="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
      <div class="flex items-center justify-between text-xs text-slate-500 font-medium">
        <span>Liquid Bank Cash</span>
        <span class="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-mono text-[10px]">Checking + HYSA</span>
      </div>
      <div class="text-xl font-bold font-mono text-slate-900 mt-1.5">${fmtMoney(k.totalLiquidCash)}</div>
      <div class="text-[11px] text-slate-500 mt-1">Credit Cards Owed: <span class="text-rose-600 font-mono">${fmtMoney(k.totalCreditCardDebt)}</span></div>
    </div>

    <div class="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
      <div class="flex items-center justify-between text-xs text-slate-500 font-medium">
        <span>YTD Total Income</span>
        <span class="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 font-mono text-[10px]">Revenue</span>
      </div>
      <div class="text-xl font-bold font-mono text-emerald-600 mt-1.5">${fmtMoney(k.ytdIncome)}</div>
      <div class="text-[11px] text-slate-500 mt-1">Oct Income: <span class="font-mono text-slate-700">${fmtMoney(k.monthIncome)}</span></div>
    </div>

    <div class="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
      <div class="flex items-center justify-between text-xs text-slate-500 font-medium">
        <span>YTD Total Expenses</span>
        <span class="px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 font-mono text-[10px]">Outflows</span>
      </div>
      <div class="text-xl font-bold font-mono text-rose-600 mt-1.5">${fmtMoney(k.ytdExpenses)}</div>
      <div class="text-[11px] text-slate-500 mt-1">Oct Spent: <span class="font-mono text-slate-700">${fmtMoney(k.monthExpenses)}</span></div>
    </div>

    <div class="bg-slate-900 text-white rounded-xl p-4 shadow-sm">
      <div class="flex items-center justify-between text-xs text-slate-400 font-medium">
        <span>YTD Net Savings</span>
        <span class="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-mono text-[10px]">${k.ytdSavingsRate}% Rate</span>
      </div>
      <div class="text-xl font-bold font-mono text-emerald-400 mt-1.5">${fmtMoney(k.ytdNetIncome)}</div>
      <div class="text-[11px] text-slate-400 mt-1">Oct Net: <span class="font-mono text-white">${fmtMoney(k.monthNetIncome)}</span></div>
    </div>
  `;

  // Bank & Credit Accounts List
  const keyAccs = APP.accounts.filter((a) =>
    ['BANK', 'INVESTMENT', 'CREDIT_CARD', 'LOAN'].includes(a.subtype)
  );
  document.getElementById('dashboardAccountsList').innerHTML = keyAccs.map((a) => `
    <div class="py-2.5 flex items-center justify-between">
      <div>
        <button onclick="openAccountLedgerModal(${a.id})" class="font-semibold text-slate-800 hover:text-emerald-600 text-xs text-left transition">
          ${escapeHtml(a.code)} &middot; ${escapeHtml(a.name)}
        </button>
        <div class="text-[10px] text-slate-400 uppercase">${escapeHtml(a.type)} &bull; ${escapeHtml(a.subtype)}</div>
      </div>
      <div class="font-mono font-semibold text-xs ${a.type === 'LIABILITY' ? 'text-rose-600' : 'text-slate-900'}">
        ${fmtMoney(a.balance)}
      </div>
    </div>
  `).join('');

  // Recent Transactions Table
  const recentTxs = APP.transactions.slice(0, 8);
  document.getElementById('dashboardRecentTxBody').innerHTML = recentTxs.map((tx) => {
    const isOutflow = tx.source_type === 'EXPENSE' || tx.signed_impact < 0;
    return `
      <tr class="hover:bg-slate-50 cursor-pointer" onclick="openEditTransactionModal(${tx.id})" title="Click to Edit Transaction / Journal Entry">
        <td class="py-2.5 px-2 font-mono text-[11px] text-slate-600">${escapeHtml(tx.date)}</td>
        <td class="py-2.5 px-2">
          <div class="font-semibold text-slate-800">${escapeHtml(tx.payee || tx.memo || tx.entry_number)}</div>
          <div class="text-[11px] text-slate-400 truncate max-w-xs">${escapeHtml(tx.memo)}</div>
        </td>
        <td class="py-2.5 px-2 text-slate-600">${escapeHtml(tx.primary_account_name)}</td>
        <td class="py-2.5 px-2">
          <span class="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 text-[11px] font-medium">${escapeHtml(tx.category_account_name)}</span>
        </td>
        <td class="py-2.5 px-2 text-right font-mono font-semibold ${tx.source_type === 'INCOME' ? 'text-emerald-600' : isOutflow ? 'text-rose-600' : 'text-slate-800'}">
          ${tx.source_type === 'INCOME' ? '+' : isOutflow ? '-' : ''}${fmtMoney(tx.total_amount)}
        </td>
      </tr>
    `;
  }).join('');

  renderDashboardCharts();
}

function renderDashboardCharts() {
  const ctxFlow = document.getElementById('cashFlowChart');
  if (ctxFlow) {
    if (cashFlowChartInstance) cashFlowChartInstance.destroy();
    const labels = APP.monthlyTrends.map((m) => m.month);
    const incData = APP.monthlyTrends.map((m) => m.income);
    const expData = APP.monthlyTrends.map((m) => m.expense);
    const netData = APP.monthlyTrends.map((m) => m.net);

    cashFlowChartInstance = new Chart(ctxFlow, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Income ($)',
            data: incData,
            backgroundColor: '#10b981',
            borderRadius: 6
          },
          {
            label: 'Expenses ($)',
            data: expData,
            backgroundColor: '#f43f5e',
            borderRadius: 6
          },
          {
            label: 'Net Savings ($)',
            data: netData,
            type: 'line',
            borderColor: '#0f172a',
            backgroundColor: '#0f172a',
            borderWidth: 2,
            tension: 0.3
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } }
        },
        scales: {
          y: { beginAtZero: true, grid: { color: '#f1f5f9' } },
          x: { grid: { display: false } }
        }
      }
    });
  }

  const ctxDonut = document.getElementById('expenseDonutChart');
  if (ctxDonut) {
    if (expenseDonutChartInstance) expenseDonutChartInstance.destroy();
    const sortedExp = [...(APP.ytdExpenseBreakdown || [])]
      .filter((e) => e.amount > 0)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 6);

    expenseDonutChartInstance = new Chart(ctxDonut, {
      type: 'doughnut',
      data: {
        labels: sortedExp.map((e) => e.name),
        datasets: [
          {
            data: sortedExp.map((e) => e.amount),
            backgroundColor: ['#0f172a', '#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#f43f5e'],
            borderWidth: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 10, font: { size: 10 } } }
        }
      }
    });
  }
}

// ================= 2. TRANSACTIONS & DOUBLE-ENTRY JOURNAL VIEW =================
function setTransactionViewMode(mode) {
  APP.txViewMode = mode;
  const btnSimple = document.getElementById('btnModeSimple');
  const btnJournal = document.getElementById('btnModeJournal');
  const simpleBox = document.getElementById('simpleRegisterContainer');
  const journalBox = document.getElementById('doubleEntryJournalContainer');

  if (mode === 'SIMPLE') {
    btnSimple.className = 'px-3.5 py-1.5 rounded-md text-xs font-semibold bg-white text-slate-900 shadow-sm transition';
    btnJournal.className = 'px-3.5 py-1.5 rounded-md text-xs font-semibold text-slate-600 hover:text-slate-900 transition';
    simpleBox.classList.remove('hidden');
    journalBox.classList.add('hidden');
  } else {
    btnJournal.className = 'px-3.5 py-1.5 rounded-md text-xs font-semibold bg-white text-slate-900 shadow-sm transition';
    btnSimple.className = 'px-3.5 py-1.5 rounded-md text-xs font-semibold text-slate-600 hover:text-slate-900 transition';
    simpleBox.classList.add('hidden');
    journalBox.classList.remove('hidden');
  }
  renderTransactionsView();
}

function renderTransactionsView() {
  const search = (document.getElementById('txSearchInput')?.value || '').toLowerCase().trim();
  const accId = Number(document.getElementById('txAccountFilter')?.value || 0);
  const typeFilter = document.getElementById('txTypeFilter')?.value || '';

  const filtered = APP.transactions.filter((tx) => {
    if (typeFilter && tx.source_type !== typeFilter) return false;
    if (accId && !tx.lines.some((l) => l.account_id === accId)) return false;
    if (search) {
      const hay = `${tx.entry_number} ${tx.payee} ${tx.memo} ${tx.reference} ${tx.category_account_name}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  if (APP.txViewMode === 'SIMPLE') {
    const tbody = document.getElementById('simpleRegisterBody');
    tbody.innerHTML = filtered.map((tx) => {
      const statusBadge = tx.reconciled_status === 'RECONCILED'
        ? '<span class="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-semibold text-[10px]">R</span>'
        : tx.reconciled_status === 'CLEARED'
        ? '<span class="px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 font-semibold text-[10px]">C</span>'
        : '<span class="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 font-mono text-[10px]">U</span>';

      return `
        <tr class="hover:bg-slate-50/80">
          <td class="py-3 px-3">
            <div class="font-mono font-semibold text-slate-800">${escapeHtml(tx.date)}</div>
            <div class="font-mono text-[10px] text-slate-400">${escapeHtml(tx.entry_number)}</div>
          </td>
          <td class="py-3 px-3">
            <span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-700">${escapeHtml(tx.source_type)}</span>
          </td>
          <td class="py-3 px-3">
            <div class="font-semibold text-slate-900">${escapeHtml(tx.payee || '—')}</div>
            <div class="text-[11px] text-slate-500">${escapeHtml(tx.memo || '')}</div>
          </td>
          <td class="py-3 px-3 text-slate-700 font-medium">${escapeHtml(tx.primary_account_name)}</td>
          <td class="py-3 px-3">
            <select onchange="quickUpdateTxCategory(${tx.id}, this.value)" class="px-2 py-1 rounded border border-slate-200 hover:border-slate-300 bg-white text-xs text-slate-800 max-w-[230px]">
              ${APP.accounts.map((a) => `<option value="${a.id}" ${a.id === tx.category_account_id ? 'selected' : ''}>${escapeHtml(a.code)} - ${escapeHtml(a.name)}</option>`).join('')}
            </select>
          </td>
          <td class="py-3 px-3 text-center">
            <input type="checkbox" ${tx.is_tax_deductible ? 'checked' : ''} onchange="quickToggleTaxDeductible(${tx.id}, this.checked)" class="rounded text-emerald-600 cursor-pointer" />
          </td>
          <td class="py-3 px-3 text-center">${statusBadge}</td>
          <td class="py-3 px-3 text-right font-mono font-bold ${tx.source_type === 'INCOME' ? 'text-emerald-600' : tx.source_type === 'EXPENSE' ? 'text-rose-600' : 'text-slate-900'}">
            ${fmtMoney(tx.total_amount)}
          </td>
          <td class="py-3 px-3 text-right whitespace-nowrap">
            <div class="inline-flex items-center gap-1">
              <button onclick="openEditTransactionModal(${tx.id})" class="px-2 py-1 rounded border border-slate-300 hover:bg-slate-900 hover:text-white text-slate-700 font-semibold text-[11px] transition" title="Edit Transaction">Edit</button>
              <button onclick="openEditJournalEntryModal(${tx.id})" class="px-2 py-1 rounded border border-indigo-200 bg-indigo-50/70 hover:bg-indigo-600 hover:text-white text-indigo-700 font-semibold text-[11px] transition" title="Edit Double-Entry Journal Lines (DR/CR)">DR/CR</button>
              <button onclick="deleteJournalEntry(${tx.id})" class="px-2 py-1 rounded border border-rose-200 bg-rose-50/70 hover:bg-rose-600 hover:text-white text-rose-700 font-semibold text-[11px] transition" title="Delete Entry">Delete</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  } else {
    // Double-Entry General Journal View
    const container = document.getElementById('doubleEntryJournalContainer');
    container.innerHTML = filtered.map((tx) => `
      <div class="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
        <div class="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between text-xs">
          <div class="flex items-center gap-3">
            <span class="font-mono font-bold text-slate-900">${escapeHtml(tx.entry_number)}</span>
            <span class="font-mono text-slate-600">${escapeHtml(tx.date)}</span>
            <span class="px-2 py-0.5 rounded bg-slate-200/70 text-slate-700 text-[10px] font-semibold">${escapeHtml(tx.source_type)}</span>
            <span class="font-semibold text-slate-800">${escapeHtml(tx.payee)}</span>
            <span class="text-slate-500">${escapeHtml(tx.memo)}</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-[11px] font-mono text-emerald-700 font-semibold mr-1">DR = CR (${fmtMoney(tx.total_amount)})</span>
            <button onclick="openEditJournalEntryModal(${tx.id})" class="px-2.5 py-1 rounded border border-slate-300 bg-white hover:bg-slate-900 hover:text-white text-slate-700 font-semibold text-[11px] transition">Edit Journal</button>
            <button onclick="deleteJournalEntry(${tx.id})" class="px-2.5 py-1 rounded border border-rose-200 bg-rose-50 hover:bg-rose-600 hover:text-white text-rose-700 font-semibold text-[11px] transition">Delete</button>
          </div>
        </div>
        <table class="w-full text-left border-collapse text-xs">
          <thead>
            <tr class="border-b border-slate-100 text-slate-400 text-[10px] uppercase">
              <th class="py-1.5 px-4">Account Code & Name</th>
              <th class="py-1.5 px-4">Type</th>
              <th class="py-1.5 px-4">Line Description</th>
              <th class="py-1.5 px-4 text-center">Reconciled</th>
              <th class="py-1.5 px-4 text-right w-32">Debit</th>
              <th class="py-1.5 px-4 text-right w-32">Credit</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-50">
            ${tx.lines.map((l) => `
              <tr>
                <td class="py-2 px-4 font-medium text-slate-800">${escapeHtml(l.account_code)} - ${escapeHtml(l.account_name)}</td>
                <td class="py-2 px-4 text-[11px] text-slate-500 font-mono">${escapeHtml(l.account_type)}</td>
                <td class="py-2 px-4 text-slate-600">${escapeHtml(l.description)}</td>
                <td class="py-2 px-4 text-center font-mono text-[10px] text-slate-500">${escapeHtml(l.reconciled_status)}</td>
                <td class="py-2 px-4 text-right font-mono ${l.debit > 0 ? 'text-slate-900 font-semibold' : 'text-slate-300'}">${l.debit > 0 ? fmtMoney(l.debit) : '—'}</td>
                <td class="py-2 px-4 text-right font-mono ${l.credit > 0 ? 'text-slate-900 font-semibold' : 'text-slate-300'}">${l.credit > 0 ? fmtMoney(l.credit) : '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `).join('');
  }
}

async function quickUpdateTxCategory(entryId, newAccountId) {
  try {
    await apiFetch(`/api/journal-entries/${entryId}/category`, {
      method: 'PUT',
      body: JSON.stringify({ category_account_id: Number(newAccountId) })
    });
    showToast('Transaction category updated in General Ledger');
    await loadBootstrap();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function quickToggleTaxDeductible(entryId, isDeductible) {
  try {
    await apiFetch(`/api/journal-entries/${entryId}/category`, {
      method: 'PUT',
      body: JSON.stringify({ is_tax_deductible: isDeductible ? 1 : 0 })
    });
    showToast(isDeductible ? 'Marked as Tax-Deductible' : 'Removed Tax-Deductible flag');
    await loadBootstrap();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteJournalEntry(entryId) {
  try {
    await apiFetch(`/api/journal-entries/${entryId}`, { method: 'DELETE' });
    showToast('Journal entry deleted');
    await loadBootstrap();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ================= 3. BANK STATEMENT & TRANSACTION CSV IMPORT & EXPORT =================
async function handleCSVFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  APP.csvFilename = file.name;
  const text = await file.text();
  APP.csvRawText = text;
  await runCSVPreview(null);
}

async function loadSampleCSVIntoImporter() {
  try {
    const res = await fetch('/api/export/sample-bank-csv');
    const text = await res.text();
    APP.csvFilename = 'sample_bank_statement_oct2026.csv';
    APP.csvRawText = text;
    await runCSVPreview(null);
    showToast('Sample Bank CSV loaded! Review auto-categorized rows below.');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function runCSVPreview(customMapping = null) {
  try {
    const bankAccountId = document.getElementById('importTargetAccount').value;
    const preview = await apiFetch('/api/import/csv-preview', {
      method: 'POST',
      body: JSON.stringify({
        csvText: APP.csvRawText,
        bankAccountId: Number(bankAccountId),
        customMapping
      })
    });
    if (Array.isArray(preview.accounts) && preview.accounts.length > 0) {
      APP.accounts = preview.accounts;
      renderCOAView();
    }
    APP.csvPreviewData = preview;
    renderCSVPreviewUI();
    if (preview.createdCategoriesCount > 0) {
      showToast(`Detected & created ${preview.createdCategoriesCount} new category account(s) from your CSV file!`);
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderCSVPreviewUI() {
  const p = APP.csvPreviewData;
  if (!p) return;

  document.getElementById('csvPreviewSection').classList.remove('hidden');
  document.getElementById('csvStatTotal').textContent = p.totalRows ?? p.validCount ?? 0;
  document.getElementById('csvStatMatched').textContent = p.ruleMatchedCount ?? p.autoCategorizedCount ?? 0;
  document.getElementById('csvStatDuplicates').textContent = p.duplicateCount ?? 0;

  const bulkCatSelect = document.getElementById('csvBulkCategorySelect');
  if (bulkCatSelect) {
    bulkCatSelect.innerHTML = APP.accounts
      .map((a) => `<option value="${a.id}">${escapeHtml(a.code)} - ${escapeHtml(a.name)} (${escapeHtml(a.type)})</option>`)
      .join('');
  }

  const fields = [
    { key: 'dateCol', label: 'Date Column' },
    { key: 'descriptionCol', label: 'Description' },
    { key: 'payeeCol', label: 'Payee' },
    { key: 'amountCol', label: 'Signed Amount' },
    { key: 'debitCol', label: 'Withdrawal/Debit' },
    { key: 'creditCol', label: 'Deposit/Credit' },
    { key: 'categoryCol', label: 'Category / GL Account' },
    { key: 'accountCol', label: 'Bank / Payment Account' }
  ];

  document.getElementById('csvColumnMapGrid').innerHTML = fields.map((f) => `
    <div>
      <label class="block text-[10px] font-semibold text-slate-500 mb-0.5">${f.label}</label>
      <select id="map_${f.key}" class="w-full px-2 py-1 rounded border border-slate-300 bg-white text-xs">
        ${p.headers.map((h, i) => `<option value="${i}" ${p.mapping[f.key] === i ? 'selected' : ''}>${escapeHtml(h)}</option>`).join('')}
        <option value="-1" ${(p.mapping[f.key] === undefined || p.mapping[f.key] === -1) ? 'selected' : ''}>— None —</option>
      </select>
    </div>
  `).join('');

  renderCSVPreviewRows();
}

function renderCSVPreviewRows() {
  const p = APP.csvPreviewData;
  if (!p) return;

  const paymentEligibleAccounts = APP.accounts.filter((a) => ['ASSET', 'LIABILITY', 'EQUITY'].includes(a.type));
  const tbody = document.getElementById('csvPreviewTableBody');
  tbody.innerHTML = p.transactions.map((t, idx) => {
    const ruleLabel = t.matchedRuleName || t.matchedRule;
    const csvCatText = t.csvCategory ? String(t.csvCategory).trim() : '';
    const defaultPayAccId = Number(t.paymentAccountId) || Number(document.getElementById('importTargetAccount')?.value);
    return `
      <tr class="${t.isDuplicate ? 'bg-amber-50/60' : 'hover:bg-slate-50'}">
        <td class="py-2 px-2.5">
          <input type="checkbox" ${t.selected ? 'checked' : ''} onchange="APP.csvPreviewData.transactions[${idx}].selected = this.checked" />
        </td>
        <td class="py-2 px-1.5">
          <input type="date" value="${escapeHtml(t.date)}" onchange="APP.csvPreviewData.transactions[${idx}].date = this.value" class="px-1.5 py-1 rounded border border-slate-200 font-mono text-[11px] w-32 bg-white" />
        </td>
        <td class="py-2 px-1.5">
          <input type="text" value="${escapeHtml(t.description)}" oninput="APP.csvPreviewData.transactions[${idx}].description = this.value" placeholder="Description / Memo" class="px-2 py-1 rounded border border-slate-200 text-xs w-48 bg-white" />
        </td>
        <td class="py-2 px-1.5">
          <input type="text" value="${escapeHtml(t.payee)}" oninput="APP.csvPreviewData.transactions[${idx}].payee = this.value" placeholder="Payee" class="px-2 py-1 rounded border border-slate-200 text-xs w-36 bg-white" />
        </td>
        <td class="py-2 px-1.5">
          <select onchange="onCSVPreviewTxTypeChange(${idx}, this.value)" class="px-1.5 py-1 rounded border border-slate-200 bg-white text-[11px] font-semibold ${t.txType === 'INCOME' ? 'text-emerald-700' : t.txType === 'TRANSFER' ? 'text-indigo-700' : 'text-rose-700'}">
            <option value="EXPENSE" ${t.txType === 'EXPENSE' ? 'selected' : ''}>Expense (-)</option>
            <option value="INCOME" ${t.txType === 'INCOME' ? 'selected' : ''}>Income (+)</option>
            <option value="TRANSFER" ${t.txType === 'TRANSFER' ? 'selected' : ''}>Transfer</option>
          </select>
        </td>
        <td class="py-2 px-1.5">
          <select onchange="onCSVPreviewCategoryChange(${idx}, this.value)" class="px-2 py-1 rounded border border-slate-300 bg-white text-xs w-52 font-medium text-slate-900">
            ${APP.accounts.map((a) => `<option value="${a.id}" ${Number(a.id) === Number(t.categoryAccountId) ? 'selected' : ''}>${escapeHtml(a.code)} - ${escapeHtml(a.name)} (${escapeHtml(a.type)})</option>`).join('')}
          </select>
          <div class="mt-0.5 flex flex-wrap items-center gap-1">
            ${t.isDuplicate
              ? `<span class="px-1.5 py-0.2 rounded bg-amber-100 text-amber-800 font-semibold text-[9px]">Duplicate (${escapeHtml(t.duplicateEntryNumber)})</span>`
              : csvCatText
              ? `<span class="px-1.5 py-0.2 rounded bg-emerald-100 text-emerald-800 font-semibold text-[9px]" title="Category detected from your CSV file">✓ CSV: ${escapeHtml(csvCatText)}</span>`
              : ruleLabel
              ? `<span class="px-1.5 py-0.2 rounded bg-blue-100 text-blue-800 font-semibold text-[9px]">${escapeHtml(ruleLabel)}</span>`
              : `<span class="text-[9px] text-slate-400">Review / Change Category</span>`
            }
          </div>
        </td>
        <td class="py-2 px-1.5">
          <select onchange="APP.csvPreviewData.transactions[${idx}].paymentAccountId = Number(this.value)" class="px-2 py-1 rounded border border-slate-200 bg-white text-[11px] w-40">
            ${paymentEligibleAccounts.map((a) => `<option value="${a.id}" ${Number(a.id) === defaultPayAccId ? 'selected' : ''}>${escapeHtml(a.code)} - ${escapeHtml(a.name)}</option>`).join('')}
          </select>
        </td>
        <td class="py-2 px-1.5 text-center">
          <input type="checkbox" ${t.isTaxDeductible ? 'checked' : ''} onchange="APP.csvPreviewData.transactions[${idx}].isTaxDeductible = this.checked ? 1 : 0" />
        </td>
        <td class="py-2 px-1.5 text-right">
          <input type="number" step="0.01" min="0" value="${Number(t.absAmount || 0).toFixed(2)}" oninput="onCSVPreviewAmountChange(${idx}, this.value)" class="px-2 py-1 rounded border border-slate-200 bg-white text-right font-mono font-bold text-xs w-28 ${t.txType === 'INCOME' ? 'text-emerald-600' : 'text-rose-600'}" />
        </td>
      </tr>
    `;
  }).join('');
}

function onCSVPreviewTxTypeChange(idx, newType) {
  if (!APP.csvPreviewData || !APP.csvPreviewData.transactions[idx]) return;
  const row = APP.csvPreviewData.transactions[idx];
  row.txType = newType;
  row.signedAmount = newType === 'INCOME' ? Math.abs(row.absAmount) : -Math.abs(row.absAmount);
  renderCSVPreviewRows();
}

function onCSVPreviewCategoryChange(idx, newAccountId) {
  if (!APP.csvPreviewData || !APP.csvPreviewData.transactions[idx]) return;
  const row = APP.csvPreviewData.transactions[idx];
  const accId = Number(newAccountId);
  row.categoryAccountId = accId;
  const acc = APP.accounts.find((a) => Number(a.id) === accId);
  if (acc) {
    row.categoryAccountName = `${acc.code} - ${acc.name}`;
    row.matchedRule = `Reviewed (${acc.code})`;
    row.matchedRuleName = `Reviewed (${acc.code})`;
  }
}

function onCSVPreviewAmountChange(idx, rawVal) {
  if (!APP.csvPreviewData || !APP.csvPreviewData.transactions[idx]) return;
  const row = APP.csvPreviewData.transactions[idx];
  const val = Math.max(0, Math.round((parseFloat(rawVal) || 0) * 100) / 100);
  row.absAmount = val;
  row.signedAmount = row.txType === 'INCOME' ? val : -val;
}

function applyBulkCategoryToCSVPreview() {
  if (!APP.csvPreviewData || !Array.isArray(APP.csvPreviewData.transactions)) return;
  const catId = Number(document.getElementById('csvBulkCategorySelect')?.value);
  if (!catId) return;
  const acc = APP.accounts.find((a) => Number(a.id) === catId);
  if (!acc) return;
  let count = 0;
  APP.csvPreviewData.transactions.forEach((t) => {
    if (t.selected) {
      t.categoryAccountId = acc.id;
      t.categoryAccountName = `${acc.code} - ${acc.name}`;
      t.matchedRule = `Bulk Assigned (${acc.code})`;
      t.matchedRuleName = `Bulk Assigned (${acc.code})`;
      count++;
    }
  });
  renderCSVPreviewRows();
  showToast(`Applied category "${acc.code} - ${acc.name}" to ${count} selected row(s)!`);
}

function toggleAllCSVPreviewRows(checked) {
  if (!APP.csvPreviewData) return;
  APP.csvPreviewData.transactions.forEach((t) => {
    t.selected = checked;
  });
  renderCSVPreviewRows();
}

async function repreviewWithCustomMapping() {
  const customMapping = {
    dateCol: Number(document.getElementById('map_dateCol').value),
    descriptionCol: Number(document.getElementById('map_descriptionCol').value),
    payeeCol: Number(document.getElementById('map_payeeCol').value),
    amountCol: Number(document.getElementById('map_amountCol').value),
    debitCol: Number(document.getElementById('map_debitCol').value),
    creditCol: Number(document.getElementById('map_creditCol').value),
    categoryCol: Number(document.getElementById('map_categoryCol')?.value ?? -1),
    accountCol: Number(document.getElementById('map_accountCol')?.value ?? -1),
    typeCol: -1,
    referenceCol: -1
  };
  await runCSVPreview(customMapping);
}

async function commitCSVImport() {
  if (!APP.csvPreviewData) return;
  try {
    const bankAccountId = Number(document.getElementById('importTargetAccount').value);
    const autoLearnRules = document.getElementById('csvAutoLearnRules')?.checked !== false;
    const res = await apiFetch('/api/import/csv-commit', {
      method: 'POST',
      body: JSON.stringify({
        filename: APP.csvFilename,
        bankAccountId,
        autoLearnRules,
        rows: APP.csvPreviewData.transactions
      })
    });
    const learnedMsg = res.learnedRulesCount > 0 ? ` (+${res.learnedRulesCount} new auto-categorization rule(s) learned!)` : '';
    showToast(`Imported ${res.importedCount} transactions into General Ledger!${learnedMsg}`);
    document.getElementById('csvPreviewSection').classList.add('hidden');
    APP.csvPreviewData = null;
    await loadBootstrap();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderImportExportView() {
  renderBackupSnapshotsList();
  const list = document.getElementById('importBatchesList');
  if (!APP.importBatches || APP.importBatches.length === 0) {
    list.innerHTML = `<div class="text-slate-400 italic">No CSV batches imported yet. Click "Try Instant Sample Statement" above to test!</div>`;
    return;
  }
  list.innerHTML = APP.importBatches.map((b) => `
    <div class="p-3 rounded-lg bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-2">
      <div>
        <span class="font-semibold text-slate-800">${escapeHtml(b.filename)}</span>
        <span class="text-slate-500 ml-2">&rarr; ${escapeHtml(b.account_code)} ${escapeHtml(b.account_name)}</span>
      </div>
      <div class="flex items-center gap-3 font-mono text-[11px]">
        <span class="text-emerald-700">${b.imported_count} imported</span>
        <span class="text-slate-500">In: ${fmtMoney(b.total_inflow)}</span>
        <span class="text-rose-600">Out: ${fmtMoney(b.total_outflow)}</span>
      </div>
    </div>
  `).join('');
}

function renderBackupSnapshotsList() {
  const backups = APP.backups || [];
  const badge = document.getElementById('latestBackupBadge');
  const statusText = document.getElementById('latestBackupStatusText');
  const listEl = document.getElementById('backupSnapshotsList');

  if (backups.length > 0) {
    const latest = backups[0];
    if (badge) {
      badge.textContent = `${backups.length} Saved`;
      badge.className = 'text-[10px] font-mono text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full';
    }
    if (statusText) {
      statusText.textContent = `Latest: ${latest.label} (${latest.created_at}) — ${latest.account_count} accts, ${latest.entry_count} entries`;
    }
    if (listEl) {
      listEl.innerHTML = backups.map((b, idx) => `
        <div class="p-2.5 rounded-lg border ${idx === 0 ? 'bg-emerald-50/40 border-emerald-200' : 'bg-slate-50 border-slate-200'} flex items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="font-semibold text-slate-800 truncate flex items-center gap-1.5">
              ${idx === 0 ? '<span class="px-1.5 py-0.5 rounded bg-emerald-600 text-white text-[9px] uppercase font-bold">Latest</span>' : ''}
              <span>${escapeHtml(b.label)}</span>
            </div>
            <div class="text-[10px] text-slate-500 font-mono">${escapeHtml(b.created_at)} &bull; ${b.account_count} accounts &bull; ${b.entry_count} journal entries</div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <button type="button" onclick="restoreBackupSnapshotById(${b.id})" class="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-[11px] transition">
              Restore
            </button>
            <button type="button" onclick="deleteBackupSnapshotById(${b.id})" class="px-1.5 py-1 text-slate-400 hover:text-rose-600 text-xs" title="Remove snapshot">&times;</button>
          </div>
        </div>
      `).join('');
    }
  } else {
    if (badge) {
      badge.textContent = 'No Snapshot Yet';
      badge.className = 'text-[10px] font-mono text-slate-500 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded-full';
    }
    if (statusText) {
      statusText.textContent = 'Click "Download Backup (.JSON)" or "+ Save Instant Snapshot" to create your first restore point';
    }
    if (listEl) {
      listEl.innerHTML = `<div class="text-[11px] text-slate-400 italic py-1">No saved backup snapshots yet.</div>`;
    }
  }
}

async function createBackupSnapshot() {
  try {
    const label = `Manual Backup (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`;
    await apiFetch('/api/backups/create', {
      method: 'POST',
      body: JSON.stringify({ label })
    });
    showToast('Backup snapshot saved! You can restore it anytime in 1 click.');
    await loadBootstrap();
  } catch (err) {
    showToast('Failed to save backup snapshot: ' + err.message, 'error');
  }
}

async function restoreLatestBackup() {
  try {
    const res = await apiFetch('/api/backups/restore-latest', { method: 'POST' });
    const snap = res.restoredSnapshot || res;
    showToast(`Restored latest backup: ${snap.label || 'Snapshot'} (${snap.created_at || 'just now'})!`);
    await loadBootstrap();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function restoreBackupSnapshotById(snapshotId) {
  try {
    const res = await apiFetch(`/api/backups/${snapshotId}/restore`, { method: 'POST' });
    const snap = res.restoredSnapshot || res;
    showToast(`Restored backup snapshot: ${snap.label || 'Snapshot'}!`);
    await loadBootstrap();
  } catch (err) {
    showToast('Restore failed: ' + err.message, 'error');
  }
}

async function deleteBackupSnapshotById(snapshotId) {
  try {
    await apiFetch(`/api/backups/${snapshotId}`, { method: 'DELETE' });
    showToast('Backup snapshot removed');
    await loadBootstrap();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleBackupRestoreFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    await apiFetch('/api/import/backup-restore', {
      method: 'POST',
      body: JSON.stringify(json)
    });
    showToast('Full accounting database restored from backup file!');
    event.target.value = '';
    await loadBootstrap();
  } catch (err) {
    showToast('Backup restore failed: ' + err.message, 'error');
  }
}

// ================= 4. CHART OF ACCOUNTS & GENERAL LEDGER =================
function setCOAFilter(type) {
  APP.coaFilter = type;
  document.querySelectorAll('.coa-filter-btn').forEach((btn) => {
    const active = btn.dataset.coa === type;
    btn.className = active
      ? 'coa-filter-btn active px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-900 text-white'
      : 'coa-filter-btn px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200';
  });
  renderCOAView();
}

function renderCOAView() {
  const filtered = APP.accounts.filter((a) => APP.coaFilter === 'ALL' || a.type === APP.coaFilter);
  const typeBadgeColors = {
    ASSET: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    LIABILITY: 'bg-rose-50 text-rose-700 border-rose-200',
    EQUITY: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    INCOME: 'bg-teal-50 text-teal-700 border-teal-200',
    EXPENSE: 'bg-amber-50 text-amber-800 border-amber-200'
  };

  document.getElementById('coaTableBody').innerHTML = filtered.map((a) => `
    <tr class="hover:bg-slate-50">
      <td class="py-3 px-4 font-mono font-bold text-slate-900">${escapeHtml(a.code)}</td>
      <td class="py-3 px-4">
        <div class="font-semibold text-slate-900 flex items-center gap-1.5">
          <span>${escapeHtml(a.name)}</span>
          ${!a.is_system ? '<span class="px-1.5 py-0.2 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 text-[9px] font-semibold">Custom</span>' : ''}
        </div>
        <div class="text-[11px] text-slate-400">${escapeHtml(a.description || '')}</div>
      </td>
      <td class="py-3 px-4">
        <span class="px-2 py-0.5 rounded border text-[10px] font-semibold ${typeBadgeColors[a.type] || ''}">${escapeHtml(a.type)}</span>
        <span class="text-[11px] text-slate-500 ml-1.5 font-mono">${escapeHtml(a.subtype)}</span>
      </td>
      <td class="py-3 px-4 text-slate-500">${escapeHtml(a.tax_category || '—')}</td>
      <td class="py-3 px-4 text-right font-mono text-slate-600">${fmtMoney(a.total_debit)}</td>
      <td class="py-3 px-4 text-right font-mono text-slate-600">${fmtMoney(a.total_credit)}</td>
      <td class="py-3 px-4 text-right font-mono font-bold text-slate-900">${fmtMoney(a.balance)}</td>
      <td class="py-3 px-4 text-right whitespace-nowrap">
        <div class="inline-flex items-center gap-1.5">
          <button onclick="openAccountLedgerModal(${a.id})" class="px-2.5 py-1 rounded bg-slate-100 hover:bg-emerald-600 hover:text-white text-slate-700 font-semibold text-[11px] transition">
            Ledger (${a.line_count})
          </button>
          <button onclick="openEditAccountModal(${a.id})" class="px-2.5 py-1 rounded border border-slate-300 hover:border-slate-800 hover:bg-slate-900 hover:text-white text-slate-700 font-semibold text-[11px] transition" title="Edit Account Code, Name, Type, or Balance">
            Edit
          </button>
          <button onclick="openDeleteAccountModal(${a.id})" class="px-2.5 py-1 rounded border border-rose-200 bg-rose-50/70 hover:bg-rose-600 hover:text-white text-rose-700 font-semibold text-[11px] transition" title="Delete or Reassign Account">
            Delete
          </button>
        </div>
      </td>
    </tr>
  `).join('');
}

async function openAccountLedgerModal(accountId) {
  try {
    const data = await apiFetch(`/api/accounts/${accountId}/ledger`);
    document.getElementById('ledgerModalTitle').textContent = `${data.account.code} — ${data.account.name} (${data.account.type})`;
    document.getElementById('ledgerModalSubtitle').textContent = `Current Normal Balance: ${fmtMoney(data.ending_balance)}`;

    document.getElementById('ledgerModalBody').innerHTML = data.rows.map((r) => {
      const jeId = r.journal_entry_id || r.id;
      return `
        <tr class="hover:bg-slate-50">
          <td class="py-2.5 px-2 font-mono">${escapeHtml(r.date)}</td>
          <td class="py-2.5 px-2 font-mono text-slate-500">${escapeHtml(r.entry_number)}</td>
          <td class="py-2.5 px-2">
            <div class="font-semibold text-slate-800">${escapeHtml(r.payee || r.description)}</div>
            <div class="text-[11px] text-slate-400">${escapeHtml(r.memo)}</div>
          </td>
          <td class="py-2.5 px-2 text-center font-mono text-[10px]">${escapeHtml(r.reconciled_status)}</td>
          <td class="py-2.5 px-2 text-right font-mono">${r.debit > 0 ? fmtMoney(r.debit) : '—'}</td>
          <td class="py-2.5 px-2 text-right font-mono">${r.credit > 0 ? fmtMoney(r.credit) : '—'}</td>
          <td class="py-2.5 px-2 text-right font-mono font-bold text-slate-900">${fmtMoney(r.running_balance)}</td>
          <td class="py-2.5 px-2 text-right whitespace-nowrap">
            <div class="inline-flex items-center gap-1">
              <button onclick="closeModal('ledgerModal'); openEditJournalEntryModal(${jeId});" class="px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-900 hover:text-white text-slate-700 font-semibold text-[11px] transition" title="Edit Journal Entry">Edit</button>
              <button onclick="deleteJournalEntryFromLedger(${jeId}, ${accountId})" class="px-2 py-1 rounded border border-rose-200 bg-rose-50 hover:bg-rose-600 hover:text-white text-rose-700 font-semibold text-[11px] transition" title="Delete Journal Entry">Delete</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    openModal('ledgerModal');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteJournalEntryFromLedger(entryId, accountId) {
  try {
    await apiFetch(`/api/journal-entries/${entryId}`, { method: 'DELETE' });
    showToast('Journal entry deleted');
    await loadBootstrap();
    await openAccountLedgerModal(accountId);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ================= 5. BANK RECONCILIATION & AUTO-CATEGORIZATION RULES =================
async function loadReconciliationWorkspace() {
  try {
    const accId = document.getElementById('reconcileAccountSelect').value;
    if (!accId) return;
    const data = await apiFetch(`/api/reconcile/${accId}`);
    APP.reconcileData = data;

    // Default target balance to cleared ending balance so user can see how it works immediately
    let clearedNet = 0;
    for (const l of data.openLines) {
      if (l.reconciled_status === 'CLEARED') {
        clearedNet += l.signed_effect;
      }
    }
    const defaultTarget = Math.round((data.beginningBalance + clearedNet) * 100) / 100;
    const targetInput = document.getElementById('reconcileTargetBalance');
    if (!targetInput.value) {
      targetInput.value = defaultTarget.toFixed(2);
    }

    renderReconcileLines();
    updateReconcileMathUI();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderReconcileLines() {
  if (!APP.reconcileData) return;
  const tbody = document.getElementById('reconcileLinesBody');
  if (APP.reconcileData.openLines.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="py-8 text-center text-slate-400">All transactions in this account are already RECONCILED!</td></tr>`;
    return;
  }

  tbody.innerHTML = APP.reconcileData.openLines.map((l, idx) => `
    <tr class="${l.reconciled_status === 'CLEARED' ? 'bg-emerald-50/50' : 'hover:bg-slate-50'}">
      <td class="py-2.5 px-3">
        <input type="checkbox" ${l.reconciled_status === 'CLEARED' ? 'checked' : ''} onchange="toggleReconcileLine(${idx}, this.checked)" class="rounded text-emerald-600 cursor-pointer" />
      </td>
      <td class="py-2.5 px-2 font-mono">${escapeHtml(l.date)}</td>
      <td class="py-2.5 px-2 font-mono text-slate-500">${escapeHtml(l.entry_number)}</td>
      <td class="py-2.5 px-2">
        <div class="font-semibold text-slate-800">${escapeHtml(l.payee || l.description)}</div>
        <div class="text-[11px] text-slate-400">${escapeHtml(l.memo)}</div>
      </td>
      <td class="py-2.5 px-2 text-right font-mono">${l.debit > 0 ? fmtMoney(l.debit) : '—'}</td>
      <td class="py-2.5 px-2 text-right font-mono">${l.credit > 0 ? fmtMoney(l.credit) : '—'}</td>
      <td class="py-2.5 px-3 text-right font-mono font-bold ${l.signed_effect >= 0 ? 'text-emerald-700' : 'text-rose-600'}">
        ${l.signed_effect >= 0 ? '+' : ''}${fmtMoney(l.signed_effect)}
      </td>
    </tr>
  `).join('');
}

async function toggleReconcileLine(idx, isChecked) {
  const line = APP.reconcileData.openLines[idx];
  line.reconciled_status = isChecked ? 'CLEARED' : 'UNRECONCILED';
  renderReconcileLines();
  updateReconcileMathUI();
  await apiFetch(`/api/reconcile/line/${line.id}`, {
    method: 'PUT',
    body: JSON.stringify({ status: line.reconciled_status })
  });
}

function updateReconcileMathUI() {
  if (!APP.reconcileData) return;
  const beg = APP.reconcileData.beginningBalance;
  const clearedNet = APP.reconcileData.openLines
    .filter((l) => l.reconciled_status === 'CLEARED')
    .reduce((s, l) => s + l.signed_effect, 0);
  const clearedEnding = Math.round((beg + clearedNet) * 100) / 100;
  const target = parseFloat(document.getElementById('reconcileTargetBalance').value || '0');
  const diff = Math.round((target - clearedEnding) * 100) / 100;

  document.getElementById('recBegBalance').textContent = fmtMoney(beg);
  document.getElementById('recClearedNet').textContent = (clearedNet >= 0 ? '+' : '') + fmtMoney(clearedNet);
  document.getElementById('recClearedEnding').textContent = fmtMoney(clearedEnding);

  const diffEl = document.getElementById('recDifference');
  diffEl.textContent = fmtMoney(diff);
  diffEl.className = Math.abs(diff) < 0.01
    ? 'font-mono font-bold text-sm text-emerald-600 mt-0.5'
    : 'font-mono font-bold text-sm text-rose-600 mt-0.5';
}

function matchStatementTargetBalance() {
  if (!APP.reconcileData) return;
  const beg = APP.reconcileData.beginningBalance;
  const clearedNet = APP.reconcileData.openLines
    .filter((l) => l.reconciled_status === 'CLEARED')
    .reduce((s, l) => s + l.signed_effect, 0);
  document.getElementById('reconcileTargetBalance').value = (beg + clearedNet).toFixed(2);
  updateReconcileMathUI();
}

async function finishReconciliation() {
  if (!APP.reconcileData) return;
  try {
    const clearedIds = APP.reconcileData.openLines
      .filter((l) => l.reconciled_status === 'CLEARED')
      .map((l) => l.id);

    const statementDate = document.getElementById('reconcileStatementDate').value;
    const endingBalance = parseFloat(document.getElementById('reconcileTargetBalance').value || '0');
    const autoAdjust = document.getElementById('reconcileAutoAdjust').checked;

    await apiFetch('/api/reconcile/complete', {
      method: 'POST',
      body: JSON.stringify({
        accountId: APP.reconcileData.account.id,
        statementDate,
        endingBalance,
        lineIds: clearedIds,
        autoAdjust
      })
    });

    showToast(`Reconciled ${clearedIds.length} transactions for ${APP.reconcileData.account.name}!`);
    await loadBootstrap();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderRulesList() {
  const container = document.getElementById('rulesListContainer');
  container.innerHTML = APP.rules.map((r) => `
    <div class="py-2.5 flex items-center justify-between gap-2">
      <div>
        <div class="font-semibold text-slate-800">${escapeHtml(r.name)}</div>
        <div class="text-[11px] text-slate-500">
          If contains <code class="px-1 py-0.5 bg-slate-100 rounded text-slate-800">${escapeHtml(r.match_value)}</code>
          &rarr; <span class="font-medium text-emerald-700">${escapeHtml(r.account_code)} ${escapeHtml(r.account_name)}</span>
        </div>
      </div>
      <button onclick="deleteRule(${r.id})" class="text-slate-400 hover:text-rose-600 text-xs">&times;</button>
    </div>
  `).join('');
}

async function handleCreateRule(event) {
  event.preventDefault();
  try {
    await apiFetch('/api/rules', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('ruleName').value,
        match_value: document.getElementById('ruleMatchValue').value,
        target_account_id: Number(document.getElementById('ruleTargetAccount').value),
        assign_payee: document.getElementById('ruleAssignPayee').value,
        is_tax_deductible: document.getElementById('ruleTaxDeductible').checked ? 1 : 0
      })
    });
    event.target.reset();
    showToast('Auto-categorization rule saved!');
    await loadBootstrap();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteRule(id) {
  await apiFetch(`/api/rules/${id}`, { method: 'DELETE' });
  showToast('Rule removed');
  await loadBootstrap();
}

async function applyRulesToExisting() {
  try {
    const res = await apiFetch('/api/rules/apply-existing', { method: 'POST' });
    showToast(`Applied rules: ${res.updatedCount} uncategorized transactions updated!`);
    await loadBootstrap();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ================= 6. FINANCIAL REPORTS SUITE =================
function switchReportSubtab(rep) {
  APP.activeReportTab = rep;
  document.querySelectorAll('.rep-tab-btn').forEach((btn) => {
    const active = btn.dataset.rep === rep;
    btn.className = active
      ? 'rep-tab-btn active px-3.5 py-2 rounded-lg text-xs font-semibold bg-slate-900 text-white'
      : 'rep-tab-btn px-3.5 py-2 rounded-lg text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200';
  });
  renderActiveReport();
}

async function loadAndRenderReports() {
  try {
    const startDate = document.getElementById('repStartDate').value || '2026-01-01';
    const endDate = document.getElementById('repEndDate').value || '2026-10-31';
    APP.reportsData = await apiFetch(`/api/reports/all?startDate=${startDate}&endDate=${endDate}&asOfDate=${endDate}`);
    renderActiveReport();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function exportActiveReportCSV() {
  const startDate = document.getElementById('repStartDate').value || '2026-01-01';
  const endDate = document.getElementById('repEndDate').value || '2026-10-31';
  const type = APP.activeReportTab === 'cash-flow' ? 'pnl' : APP.activeReportTab;
  window.location.href = `/api/export/report.csv?type=${type}&startDate=${startDate}&endDate=${endDate}&asOfDate=${endDate}`;
}

function renderActiveReport() {
  if (!APP.reportsData) return;
  const box = document.getElementById('reportPaperContainer');
  const org = escapeHtml(APP.settings.organization_name || 'Personal Financial Ledger');
  const rep = APP.activeReportTab;

  if (rep === 'pnl') {
    const pnl = APP.reportsData.pnl;
    box.innerHTML = `
      <div class="border-b-2 border-slate-900 pb-4 mb-6 flex justify-between items-end">
        <div>
          <div class="text-xs font-bold uppercase tracking-widest text-emerald-600">${org}</div>
          <h2 class="text-2xl font-bold text-slate-900">Profit & Loss Statement (Income Statement)</h2>
          <p class="text-xs text-slate-500">Period: ${escapeHtml(pnl.startDate)} through ${escapeHtml(pnl.endDate)}</p>
        </div>
        <div class="text-right">
          <div class="text-xs text-slate-500">Net Savings Rate</div>
          <div class="text-xl font-mono font-bold text-emerald-600">${pnl.savingsRate}%</div>
        </div>
      </div>

      <div class="space-y-6 text-xs">
        <div>
          <h3 class="font-bold text-slate-900 uppercase tracking-wider border-b border-slate-200 pb-1.5 mb-2">Operating & Investment Income</h3>
          <div class="divide-y divide-slate-100">
            ${pnl.incomeAccounts.map((i) => `
              <div class="py-2 flex justify-between">
                <span><span class="font-mono text-slate-400 mr-2">${escapeHtml(i.code)}</span>${escapeHtml(i.name)}</span>
                <span class="font-mono font-medium">${fmtMoney(i.amount)}</span>
              </div>
            `).join('')}
          </div>
          <div class="py-2.5 border-t border-slate-300 flex justify-between font-bold text-sm text-emerald-700">
            <span>Total Income</span>
            <span class="font-mono">${fmtMoney(pnl.totalIncome)}</span>
          </div>
        </div>

        <div>
          <h3 class="font-bold text-slate-900 uppercase tracking-wider border-b border-slate-200 pb-1.5 mb-2">Expenses & Taxes</h3>
          <div class="divide-y divide-slate-100">
            ${pnl.expenseAccounts.map((e) => `
              <div class="py-2 flex justify-between">
                <span><span class="font-mono text-slate-400 mr-2">${escapeHtml(e.code)}</span>${escapeHtml(e.name)}</span>
                <span class="font-mono font-medium">${fmtMoney(e.amount)}</span>
              </div>
            `).join('')}
          </div>
          <div class="py-2.5 border-t border-slate-300 flex justify-between font-bold text-sm text-rose-700">
            <span>Total Expenses</span>
            <span class="font-mono">${fmtMoney(pnl.totalExpenses)}</span>
          </div>
        </div>

        <div class="p-4 rounded-xl bg-slate-900 text-white flex justify-between items-center text-base font-bold">
          <span>NET INCOME (NET SAVINGS)</span>
          <span class="font-mono text-emerald-400">${fmtMoney(pnl.netIncome)}</span>
        </div>
      </div>
    `;
  } else if (rep === 'balance-sheet') {
    const bs = APP.reportsData.balanceSheet;
    box.innerHTML = `
      <div class="border-b-2 border-slate-900 pb-4 mb-6 flex justify-between items-end">
        <div>
          <div class="text-xs font-bold uppercase tracking-widest text-emerald-600">${org}</div>
          <h2 class="text-2xl font-bold text-slate-900">Statement of Financial Position (Balance Sheet)</h2>
          <p class="text-xs text-slate-500">As of ${escapeHtml(bs.asOfDate)}</p>
        </div>
        <span class="px-3 py-1 rounded-full text-xs font-bold ${bs.isBalanced ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}">
          ${bs.isBalanced ? '✓ Assets = Liabilities + Equity' : 'Out of Balance'}
        </span>
      </div>

      <div class="space-y-6 text-xs">
        <div>
          <h3 class="font-bold text-slate-900 uppercase tracking-wider border-b border-slate-200 pb-1.5 mb-2">Assets</h3>
          <div class="divide-y divide-slate-100">
            ${bs.assets.map((a) => `
              <div class="py-2 flex justify-between">
                <span><span class="font-mono text-slate-400 mr-2">${escapeHtml(a.code)}</span>${escapeHtml(a.name)}</span>
                <span class="font-mono font-medium">${fmtMoney(a.balance)}</span>
              </div>
            `).join('')}
          </div>
          <div class="py-2.5 border-t border-slate-300 flex justify-between font-bold text-sm text-slate-900">
            <span>TOTAL ASSETS</span>
            <span class="font-mono">${fmtMoney(bs.totalAssets)}</span>
          </div>
        </div>

        <div>
          <h3 class="font-bold text-slate-900 uppercase tracking-wider border-b border-slate-200 pb-1.5 mb-2">Liabilities</h3>
          <div class="divide-y divide-slate-100">
            ${bs.liabilities.map((l) => `
              <div class="py-2 flex justify-between">
                <span><span class="font-mono text-slate-400 mr-2">${escapeHtml(l.code)}</span>${escapeHtml(l.name)}</span>
                <span class="font-mono font-medium">${fmtMoney(l.balance)}</span>
              </div>
            `).join('')}
          </div>
          <div class="py-2.5 border-t border-slate-300 flex justify-between font-bold text-sm text-rose-700">
            <span>TOTAL LIABILITIES</span>
            <span class="font-mono">${fmtMoney(bs.totalLiabilities)}</span>
          </div>
        </div>

        <div>
          <h3 class="font-bold text-slate-900 uppercase tracking-wider border-b border-slate-200 pb-1.5 mb-2">Equity & Net Worth</h3>
          <div class="divide-y divide-slate-100">
            ${bs.equityAccounts.map((eq) => `
              <div class="py-2 flex justify-between">
                <span><span class="font-mono text-slate-400 mr-2">${escapeHtml(eq.code)}</span>${escapeHtml(eq.name)}</span>
                <span class="font-mono font-medium">${fmtMoney(eq.balance)}</span>
              </div>
            `).join('')}
          </div>
          <div class="py-2.5 border-t border-slate-300 flex justify-between font-bold text-sm text-emerald-700">
            <span>TOTAL EQUITY (PERSONAL NET WORTH)</span>
            <span class="font-mono">${fmtMoney(bs.totalEquity)}</span>
          </div>
        </div>

        <div class="p-4 rounded-xl bg-slate-900 text-white flex justify-between items-center text-base font-bold">
          <span>TOTAL LIABILITIES & EQUITY</span>
          <span class="font-mono text-emerald-400">${fmtMoney(bs.totalLiabilitiesAndEquity)}</span>
        </div>
      </div>
    `;
  } else if (rep === 'trial-balance') {
    const tb = APP.reportsData.trialBalance;
    box.innerHTML = `
      <div class="border-b-2 border-slate-900 pb-4 mb-6 flex justify-between items-end">
        <div>
          <div class="text-xs font-bold uppercase tracking-widest text-emerald-600">${org}</div>
          <h2 class="text-2xl font-bold text-slate-900">Trial Balance</h2>
          <p class="text-xs text-slate-500">As of ${escapeHtml(tb.asOfDate)}</p>
        </div>
        <span class="px-3 py-1 rounded-full text-xs font-bold ${tb.isBalanced ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}">
          ${tb.isBalanced ? '✓ Total Debits = Total Credits' : 'Unbalanced'}
        </span>
      </div>

      <table class="w-full text-left border-collapse text-xs">
        <thead>
          <tr class="border-b-2 border-slate-300 text-slate-600 uppercase">
            <th class="py-2.5 px-2">Code</th>
            <th class="py-2.5 px-2">Account Name</th>
            <th class="py-2.5 px-2">Type</th>
            <th class="py-2.5 px-2 text-right">Debit Balance</th>
            <th class="py-2.5 px-2 text-right">Credit Balance</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          ${tb.rows.map((r) => `
            <tr>
              <td class="py-2 px-2 font-mono font-semibold">${escapeHtml(r.code)}</td>
              <td class="py-2 px-2 font-medium text-slate-800">${escapeHtml(r.name)}</td>
              <td class="py-2 px-2 font-mono text-[11px] text-slate-500">${escapeHtml(r.type)}</td>
              <td class="py-2 px-2 text-right font-mono">${r.debit_balance > 0 ? fmtMoney(r.debit_balance) : '—'}</td>
              <td class="py-2 px-2 text-right font-mono">${r.credit_balance > 0 ? fmtMoney(r.credit_balance) : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
        <tfoot class="border-t-2 border-slate-900 bg-slate-50 font-mono font-bold text-sm">
          <tr>
            <td colspan="3" class="py-3 px-2 font-sans">TOTALS</td>
            <td class="py-3 px-2 text-right text-slate-900">${fmtMoney(tb.totalDebit)}</td>
            <td class="py-3 px-2 text-right text-slate-900">${fmtMoney(tb.totalCredit)}</td>
          </tr>
        </tfoot>
      </table>
    `;
  } else if (rep === 'cash-flow') {
    const cf = APP.reportsData.cashFlow;
    box.innerHTML = `
      <div class="border-b-2 border-slate-900 pb-4 mb-6">
        <div class="text-xs font-bold uppercase tracking-widest text-emerald-600">${org}</div>
        <h2 class="text-2xl font-bold text-slate-900">Statement of Cash Flows</h2>
        <p class="text-xs text-slate-500">Period: ${escapeHtml(cf.startDate)} through ${escapeHtml(cf.endDate)}</p>
      </div>

      <div class="space-y-4 text-xs">
        <div class="p-3.5 rounded-lg bg-slate-50 border border-slate-200 flex justify-between font-semibold">
          <span>Beginning Liquid Bank Cash (${escapeHtml(cf.startDate)})</span>
          <span class="font-mono">${fmtMoney(cf.beginningCash)}</span>
        </div>

        <div class="divide-y divide-slate-200 border border-slate-200 rounded-lg p-4 space-y-3">
          <div class="py-2 flex justify-between">
            <div>
              <div class="font-bold text-slate-900">Cash Flows from Operating Activities</div>
              <div class="text-slate-500 text-[11px]">Net Income / Personal Operating Savings</div>
            </div>
            <span class="font-mono font-bold text-emerald-700">${fmtMoney(cf.operatingCashFlow)}</span>
          </div>

          <div class="py-2 flex justify-between">
            <div>
              <div class="font-bold text-slate-900">Cash Flows from Investing Activities</div>
              <div class="text-slate-500 text-[11px]">Brokerage Contributions & Fixed Asset Capital Flows</div>
            </div>
            <span class="font-mono font-bold text-slate-800">${fmtMoney(cf.investingCashFlow)}</span>
          </div>

          <div class="py-2 flex justify-between">
            <div>
              <div class="font-bold text-slate-900">Cash Flows from Financing, Credit & Opening Equity</div>
              <div class="text-slate-500 text-[11px]">Loans, Credit Card Net Changes & Opening Reserves</div>
            </div>
            <span class="font-mono font-bold text-slate-800">${fmtMoney(cf.financingAndWorkingCapital)}</span>
          </div>
        </div>

        <div class="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 flex justify-between font-bold text-emerald-900">
          <span>Net Change in Liquid Cash</span>
          <span class="font-mono">${fmtMoney(cf.netCashChange)}</span>
        </div>

        <div class="p-4 rounded-xl bg-slate-900 text-white flex justify-between items-center text-base font-bold">
          <span>ENDING LIQUID BANK CASH (${escapeHtml(cf.endDate)})</span>
          <span class="font-mono text-emerald-400">${fmtMoney(cf.endingCash)}</span>
        </div>
      </div>
    `;
  } else if (rep === 'tax-summary') {
    const tx = APP.reportsData.taxSummary;
    box.innerHTML = `
      <div class="border-b-2 border-slate-900 pb-4 mb-6 flex justify-between items-end">
        <div>
          <div class="text-xs font-bold uppercase tracking-widest text-emerald-600">${org}</div>
          <h2 class="text-2xl font-bold text-slate-900">Tax Summary & Deductible Schedule</h2>
          <p class="text-xs text-slate-500">Period: ${escapeHtml(tx.startDate)} through ${escapeHtml(tx.endDate)} (Est. Tax Rate: ${tx.estTaxRate}%)</p>
        </div>
      </div>

      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6 text-xs">
        <div class="p-3 rounded-lg bg-slate-50 border border-slate-200">
          <div class="text-slate-500">Gross Taxable Income</div>
          <div class="font-mono font-bold text-sm text-slate-900 mt-1">${fmtMoney(tx.totalTaxableIncome)}</div>
        </div>
        <div class="p-3 rounded-lg bg-emerald-50 border border-emerald-200">
          <div class="text-emerald-700">Deductible Expenses</div>
          <div class="font-mono font-bold text-sm text-emerald-800 mt-1">${fmtMoney(tx.businessAndItemizedDeductions)}</div>
        </div>
        <div class="p-3 rounded-lg bg-slate-50 border border-slate-200">
          <div class="text-slate-500">Est. Tax Liability (${tx.estTaxRate}%)</div>
          <div class="font-mono font-bold text-sm text-slate-900 mt-1">${fmtMoney(tx.estimatedTaxLiability)}</div>
        </div>
        <div class="p-3 rounded-lg bg-blue-50 border border-blue-200">
          <div class="text-blue-700">Taxes Already Paid (5200)</div>
          <div class="font-mono font-bold text-sm text-blue-900 mt-1">${fmtMoney(tx.taxesAlreadyPaid)}</div>
        </div>
      </div>

      <div class="space-y-6 text-xs">
        <div>
          <h3 class="font-bold text-slate-900 uppercase tracking-wider border-b border-slate-200 pb-1.5 mb-2">Taxable Income Streams</h3>
          <div class="divide-y divide-slate-100">
            ${tx.incomeRows.map((r) => `
              <div class="py-2 flex justify-between">
                <span><strong>${escapeHtml(r.code)} - ${escapeHtml(r.name)}</strong> <span class="text-slate-400 ml-2">(${escapeHtml(r.tax_category || 'Income')})</span></span>
                <span class="font-mono font-semibold">${fmtMoney(r.amount)}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <div>
          <h3 class="font-bold text-slate-900 uppercase tracking-wider border-b border-slate-200 pb-1.5 mb-2">Tax-Deductible Transactions & Estimated Tax Payments</h3>
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-slate-200 text-slate-500 text-[11px]">
                <th class="py-2">Date</th>
                <th class="py-2">Payee & Memo</th>
                <th class="py-2">Account</th>
                <th class="py-2">Tax Schedule</th>
                <th class="py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              ${tx.deductibleRows.map((d) => `
                <tr>
                  <td class="py-2 font-mono">${escapeHtml(d.date)}</td>
                  <td class="py-2 font-medium text-slate-800">${escapeHtml(d.payee)} — <span class="text-slate-500 font-normal">${escapeHtml(d.memo)}</span></td>
                  <td class="py-2">${escapeHtml(d.account_code)} ${escapeHtml(d.account_name)}</td>
                  <td class="py-2 text-slate-500">${escapeHtml(d.tax_category)}</td>
                  <td class="py-2 text-right font-mono font-semibold">${fmtMoney(d.amount)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }
}

// ================= 7. BUDGETS & SAVINGS GOALS =================
function renderBudgetsAndGoals() {
  const bContainer = document.getElementById('budgetsListContainer');
  bContainer.innerHTML = APP.budgets.map((b) => {
    const pct = Math.min(100, Math.max(0, b.percent_used));
    const barColor = b.percent_used > 100 ? 'bg-rose-600' : b.percent_used >= 80 ? 'bg-amber-500' : 'bg-emerald-500';
    return `
      <div class="p-4 rounded-xl border border-slate-200 bg-white space-y-2">
        <div class="flex items-center justify-between text-xs">
          <div>
            <span class="font-mono font-bold text-slate-500 mr-1.5">${escapeHtml(b.account_code)}</span>
            <span class="font-bold text-slate-900">${escapeHtml(b.account_name)}</span>
          </div>
          <div class="flex items-center gap-3 font-mono">
            <span class="text-slate-600">${fmtMoney(b.actual_month)} / <strong>${fmtMoney(b.monthly_amount)}</strong></span>
            <span class="px-2 py-0.5 rounded text-[10px] font-bold ${b.remaining >= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}">
              ${b.remaining >= 0 ? `${fmtMoney(b.remaining)} left` : `${fmtMoney(Math.abs(b.remaining))} over`}
            </span>
            <button onclick="deleteBudget(${b.id})" class="text-slate-300 hover:text-rose-600">&times;</button>
          </div>
        </div>
        <div class="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden">
          <div class="${barColor} h-full rounded-full transition-all" style="width: ${pct}%"></div>
        </div>
      </div>
    `;
  }).join('');

  const gContainer = document.getElementById('savingsGoalsContainer');
  gContainer.innerHTML = APP.savingsGoals.map((g) => {
    const pct = g.target_amount > 0 ? Math.min(100, Math.round((g.current_amount / g.target_amount) * 100)) : 0;
    return `
      <div class="p-4 rounded-xl border border-slate-200 space-y-2.5 text-xs">
        <div class="flex items-center justify-between">
          <div class="font-bold text-slate-900 text-sm">${escapeHtml(g.name)}</div>
          <span class="font-mono font-bold text-emerald-600">${pct}%</span>
        </div>
        <div class="text-[11px] text-slate-500 flex justify-between">
          <span>Saved: <strong class="font-mono text-slate-800">${fmtMoney(g.current_amount)}</strong></span>
          <span>Goal: <strong class="font-mono text-slate-800">${fmtMoney(g.target_amount)}</strong></span>
        </div>
        <div class="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden">
          <div class="h-full rounded-full" style="width: ${pct}%; background-color: ${escapeHtml(g.color || '#10b981')}"></div>
        </div>
        <div class="flex items-center justify-between pt-1">
          <span class="text-[10px] text-slate-400">Target Date: ${escapeHtml(g.target_date || 'Flexible')}</span>
          <div class="flex items-center gap-2">
            <button onclick="promptUpdateGoal(${g.id}, ${g.current_amount})" class="text-emerald-600 hover:underline font-semibold text-[11px]">+ Add Contribution</button>
            <button onclick="deleteGoal(${g.id})" class="text-slate-400 hover:text-rose-600">&times;</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

async function handleSaveBudget(event) {
  event.preventDefault();
  try {
    await apiFetch('/api/budgets', {
      method: 'POST',
      body: JSON.stringify({
        account_id: Number(document.getElementById('budgetAccountSelect').value),
        monthly_amount: parseFloat(document.getElementById('budgetMonthlyAmount').value)
      })
    });
    document.getElementById('budgetMonthlyAmount').value = '';
    showToast('Monthly budget saved!');
    await loadBootstrap();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteBudget(id) {
  await apiFetch(`/api/budgets/${id}`, { method: 'DELETE' });
  await loadBootstrap();
}

async function handleCreateGoal(event) {
  event.preventDefault();
  try {
    await apiFetch('/api/savings-goals', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('goalName').value,
        target_amount: parseFloat(document.getElementById('goalTarget').value),
        current_amount: parseFloat(document.getElementById('goalCurrent').value),
        target_date: document.getElementById('goalDate').value
      })
    });
    event.target.reset();
    showToast('Savings goal created!');
    await loadBootstrap();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function promptUpdateGoal(id, currentAmt) {
  const newAmt = Number(currentAmt) + 500;
  await apiFetch(`/api/savings-goals/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ current_amount: newAmt })
  });
  showToast('Added +$500.00 contribution to goal!');
  await loadBootstrap();
}

async function deleteGoal(id) {
  await apiFetch(`/api/savings-goals/${id}`, { method: 'DELETE' });
  await loadBootstrap();
}

// ================= 8. INVOICES (AR), BILLS (AP) & RECURRING =================
function renderInvoicesAndRecurring() {
  const bankAccs = APP.accounts.filter((a) => ['BANK', 'CREDIT_CARD'].includes(a.subtype));
  const defaultBankId = bankAccs.length > 0 ? bankAccs[0].id : 1;

  document.getElementById('invoicesBillsList').innerHTML = APP.invoicesBills.map((d) => `
    <div class="p-4 rounded-xl border border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs">
      <div>
        <div class="flex items-center gap-2">
          <span class="px-2 py-0.5 rounded font-bold text-[10px] ${d.doc_type === 'INVOICE' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}">${escapeHtml(d.doc_type)}</span>
          <span class="font-mono font-bold text-slate-900">${escapeHtml(d.doc_number)}</span>
          <span class="font-semibold text-slate-800">${escapeHtml(d.contact_name)}</span>
          <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${d.status === 'PAID' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}">${escapeHtml(d.status)}</span>
        </div>
        <div class="text-[11px] text-slate-500 mt-1">
          Issued: ${escapeHtml(d.issue_date)} &bull; Due: ${escapeHtml(d.due_date)} &bull; Account: ${escapeHtml(d.category_account_code)} ${escapeHtml(d.category_account_name)}
        </div>
      </div>
      <div class="flex items-center gap-3">
        <span class="font-mono font-bold text-sm text-slate-900">${fmtMoney(d.total_amount)}</span>
        ${d.status === 'OPEN'
          ? `<button onclick="settleInvoiceOrBill(${d.id}, ${defaultBankId})" class="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-[11px]">
              ${d.doc_type === 'INVOICE' ? 'Receive Payment' : 'Pay Bill'}
            </button>`
          : `<span class="text-[11px] text-emerald-600 font-mono">Paid ${escapeHtml(d.paid_date || '')}</span>`
        }
        <button onclick="deleteInvoiceBill(${d.id})" class="text-slate-300 hover:text-rose-600">&times;</button>
      </div>
    </div>
  `).join('');

  document.getElementById('recurringListContainer').innerHTML = APP.recurring.map((r) => `
    <div class="p-4 rounded-xl border border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs">
      <div>
        <div class="flex items-center gap-2">
          <span class="px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-semibold text-[10px]">${escapeHtml(r.frequency)}</span>
          <span class="font-bold text-slate-900">${escapeHtml(r.name)}</span>
        </div>
        <div class="text-[11px] text-slate-500 mt-1">
          Next Run: <strong class="font-mono text-slate-800">${escapeHtml(r.next_date)}</strong> &bull;
          ${escapeHtml(r.payment_account_name)} &rarr; ${escapeHtml(r.category_account_name)}
        </div>
      </div>
      <div class="flex items-center gap-3">
        <span class="font-mono font-bold text-sm ${r.tx_type === 'INCOME' ? 'text-emerald-600' : 'text-slate-900'}">${fmtMoney(r.amount)}</span>
        <button onclick="runRecurringNow(${r.id})" class="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-semibold text-[11px]">
          Post Now
        </button>
        <button onclick="deleteRecurring(${r.id})" class="text-slate-300 hover:text-rose-600">&times;</button>
      </div>
    </div>
  `).join('');
}

async function handleCreateInvoiceBill(event) {
  event.preventDefault();
  try {
    await apiFetch('/api/invoices-bills', {
      method: 'POST',
      body: JSON.stringify({
        doc_type: document.getElementById('docType').value,
        doc_number: document.getElementById('docNumber').value,
        contact_name: document.getElementById('docContact').value,
        total_amount: parseFloat(document.getElementById('docAmount').value),
        category_account_id: Number(document.getElementById('docCategoryAccount').value),
        issue_date: document.getElementById('docIssueDate').value,
        due_date: document.getElementById('docDueDate').value
      })
    });
    showToast('Accrual entry posted to General Ledger!');
    await loadBootstrap();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function settleInvoiceOrBill(id, paymentAccountId) {
  try {
    await apiFetch(`/api/invoices-bills/${id}/pay`, {
      method: 'POST',
      body: JSON.stringify({
        payment_account_id: paymentAccountId,
        paid_date: '2026-10-19'
      })
    });
    showToast('Payment settled and posted to General Ledger!');
    await loadBootstrap();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteInvoiceBill(id) {
  await apiFetch(`/api/invoices-bills/${id}`, { method: 'DELETE' });
  await loadBootstrap();
}

async function handleCreateRecurring(event) {
  event.preventDefault();
  try {
    await apiFetch('/api/recurring', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('recName').value,
        tx_type: document.getElementById('recType').value,
        frequency: document.getElementById('recFrequency').value,
        payment_account_id: Number(document.getElementById('recPaymentAcc').value),
        category_account_id: Number(document.getElementById('recCategoryAcc').value),
        amount: parseFloat(document.getElementById('recAmount').value),
        next_date: document.getElementById('recNextDate').value
      })
    });
    event.target.reset();
    showToast('Recurring schedule added!');
    await loadBootstrap();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function runRecurringNow(id) {
  try {
    const res = await apiFetch(`/api/recurring/${id}/run`, { method: 'POST' });
    showToast(`Posted scheduled transaction! Next run advanced to ${res.next_date}.`);
    await loadBootstrap();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteRecurring(id) {
  await apiFetch(`/api/recurring/${id}`, { method: 'DELETE' });
  await loadBootstrap();
}

// ================= 9. MULTI-CURRENCY & SETTINGS =================
function renderSettingsView() {
  document.getElementById('setOrgName').value = APP.settings.organization_name || '';
  document.getElementById('setBaseCurrency').value = APP.settings.base_currency || 'USD';
  document.getElementById('setTaxRate').value = APP.settings.tax_rate_estimate || '24';

  document.getElementById('currenciesTableBody').innerHTML = APP.currencies.map((c) => `
    <tr>
      <td class="py-2.5 px-2 font-mono font-bold text-slate-900">${escapeHtml(c.code)}</td>
      <td class="py-2.5 px-2 text-slate-600">${escapeHtml(c.name)}</td>
      <td class="py-2.5 px-2 font-mono">${escapeHtml(c.symbol)}</td>
      <td class="py-2.5 px-2 text-right font-mono font-semibold">${Number(c.exchange_rate).toFixed(4)}</td>
    </tr>
  `).join('');
}

async function handleSaveSettings(event) {
  event.preventDefault();
  try {
    await apiFetch('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        organization_name: document.getElementById('setOrgName').value,
        base_currency: document.getElementById('setBaseCurrency').value,
        tax_rate_estimate: document.getElementById('setTaxRate').value
      })
    });
    showToast('Ledger settings saved!');
    await loadBootstrap();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleSaveCurrency(event) {
  event.preventDefault();
  try {
    const code = document.getElementById('currCode').value.toUpperCase().trim();
    await apiFetch('/api/currencies', {
      method: 'POST',
      body: JSON.stringify({
        code,
        name: code,
        symbol: document.getElementById('currSymbol').value,
        exchange_rate: parseFloat(document.getElementById('currRate').value)
      })
    });
    event.target.reset();
    showToast(`Exchange rate for ${code} updated!`);
    await loadBootstrap();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function resetDemoDatabase() {
  await apiFetch('/api/admin/reset-demo', { method: 'POST' });
  showToast('Demo financial data restored!');
  await loadBootstrap();
}

async function clearAllTransactions() {
  await apiFetch('/api/admin/clear-transactions', { method: 'POST' });
  showToast('All transactions cleared. Chart of Accounts ready for your data!');
  await loadBootstrap();
}

// ================= MODALS: SIMPLE TRANSACTION, JOURNAL ENTRY, NEW ACCOUNT =================
function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function openNewTransactionModal(type = 'EXPENSE') {
  document.getElementById('simpleTxEditId').value = '';
  document.getElementById('simpleTxModalTitle').textContent = 'Record Transaction';
  document.getElementById('simpleTxSubmitBtn').textContent = 'Save & Post to Ledger';
  document.getElementById('simpleTxAmount').value = '';
  document.getElementById('simpleTxPayee').value = '';
  document.getElementById('simpleTxRef').value = '';
  document.getElementById('simpleTxMemo').value = '';
  document.getElementById('simpleTxTaxDeductible').checked = false;
  setSimpleModalType(type);
  openModal('simpleTxModal');
}

function openEditTransactionModal(entryId) {
  const tx = APP.transactions.find((t) => t.id === Number(entryId));
  if (!tx) return;

  // If this entry is a manual JOURNAL entry, OPENING_BALANCE, or has >2 lines, open the full Double-Entry Journal Editor
  if (tx.source_type === 'JOURNAL' || tx.source_type === 'OPENING_BALANCE' || (tx.lines && tx.lines.length > 2)) {
    return openEditJournalEntryModal(entryId);
  }

  document.getElementById('simpleTxEditId').value = String(tx.id);
  document.getElementById('simpleTxModalTitle').textContent = `Edit Transaction (${tx.entry_number})`;
  document.getElementById('simpleTxSubmitBtn').textContent = 'Update Transaction';

  let modalType = 'EXPENSE';
  if (tx.source_type === 'INCOME') modalType = 'INCOME';
  else if (tx.source_type === 'TRANSFER') modalType = 'TRANSFER';
  else if (tx.signed_impact > 0 && tx.lines.some((l) => l.account_type === 'INCOME')) modalType = 'INCOME';

  setSimpleModalType(modalType);

  document.getElementById('simpleTxDate').value = tx.date || '2026-10-19';
  document.getElementById('simpleTxAmount').value = Number(tx.total_amount || 0).toFixed(2);
  document.getElementById('simpleTxPayee').value = tx.payee || '';
  document.getElementById('simpleTxRef').value = tx.reference || '';
  document.getElementById('simpleTxMemo').value = tx.memo || '';
  document.getElementById('simpleTxCurrency').value = tx.currency || APP.settings.base_currency || 'USD';
  document.getElementById('simpleTxRate').value = Number(tx.exchange_rate || 1);
  document.getElementById('simpleTxTaxDeductible').checked = Boolean(tx.is_tax_deductible);

  // Set payment and category account dropdowns
  const paySelect = document.getElementById('simpleTxPaymentAccount');
  const catSelect = document.getElementById('simpleTxCategoryAccount');

  // Ensure primary_account_id and category_account_id exist in options
  if (tx.primary_account_id) {
    if (![...paySelect.options].some((o) => Number(o.value) === Number(tx.primary_account_id))) {
      const pAcc = APP.accounts.find((a) => a.id === Number(tx.primary_account_id));
      if (pAcc) {
        paySelect.insertAdjacentHTML('beforeend', `<option value="${pAcc.id}">${escapeHtml(pAcc.code)} - ${escapeHtml(pAcc.name)}</option>`);
      }
    }
    paySelect.value = String(tx.primary_account_id);
  }

  if (tx.category_account_id) {
    if (![...catSelect.options].some((o) => Number(o.value) === Number(tx.category_account_id))) {
      const cAcc = APP.accounts.find((a) => a.id === Number(tx.category_account_id));
      if (cAcc) {
        catSelect.insertAdjacentHTML('beforeend', `<option value="${cAcc.id}">${escapeHtml(cAcc.code)} - ${escapeHtml(cAcc.name)}</option>`);
      }
    }
    catSelect.value = String(tx.category_account_id);
  }

  openModal('simpleTxModal');
}

function setSimpleModalType(type) {
  document.getElementById('simpleTxType').value = type;
  const btnExp = document.getElementById('tabBtnExpense');
  const btnInc = document.getElementById('tabBtnIncome');
  const btnTrf = document.getElementById('tabBtnTransfer');

  btnExp.className = type === 'EXPENSE' ? 'py-2 rounded-lg font-bold transition bg-rose-600 text-white shadow-xs' : 'py-2 rounded-lg font-bold transition text-slate-700';
  btnInc.className = type === 'INCOME' ? 'py-2 rounded-lg font-bold transition bg-emerald-600 text-white shadow-xs' : 'py-2 rounded-lg font-bold transition text-slate-700';
  btnTrf.className = type === 'TRANSFER' ? 'py-2 rounded-lg font-bold transition bg-slate-900 text-white shadow-xs' : 'py-2 rounded-lg font-bold transition text-slate-700';

  const paySelect = document.getElementById('simpleTxPaymentAccount');
  const catSelect = document.getElementById('simpleTxCategoryAccount');

  const bankAndCards = APP.accounts.filter((a) => ['BANK', 'CREDIT_CARD', 'INVESTMENT'].includes(a.subtype));
  paySelect.innerHTML = bankAndCards.map((a) => `<option value="${a.id}">${escapeHtml(a.code)} - ${escapeHtml(a.name)}</option>`).join('');

  if (type === 'EXPENSE') {
    document.getElementById('lblPaymentAccount').textContent = 'Paid From (Bank / Credit Card)';
    document.getElementById('lblCategoryAccount').textContent = 'Expense / Liability Account';
    catSelect.innerHTML = APP.accounts
      .filter((a) => ['EXPENSE', 'LIABILITY', 'ASSET'].includes(a.type))
      .map((a) => `<option value="${a.id}">${escapeHtml(a.code)} - ${escapeHtml(a.name)} (${a.type})</option>`)
      .join('');
  } else if (type === 'INCOME') {
    document.getElementById('lblPaymentAccount').textContent = 'Deposit Into (Bank / Brokerage)';
    document.getElementById('lblCategoryAccount').textContent = 'Income Category Account';
    catSelect.innerHTML = APP.accounts
      .filter((a) => a.type === 'INCOME')
      .map((a) => `<option value="${a.id}">${escapeHtml(a.code)} - ${escapeHtml(a.name)}</option>`)
      .join('');
  } else {
    document.getElementById('lblPaymentAccount').textContent = 'Transfer From Account';
    document.getElementById('lblCategoryAccount').textContent = 'Transfer To Account';
    catSelect.innerHTML = bankAndCards
      .map((a) => `<option value="${a.id}">${escapeHtml(a.code)} - ${escapeHtml(a.name)}</option>`)
      .join('');
    if (catSelect.options.length > 1) catSelect.selectedIndex = 1;
  }
}

function updateSimpleModalExchangeRate() {
  const code = document.getElementById('simpleTxCurrency').value;
  const c = APP.currencies.find((x) => x.code === code);
  document.getElementById('simpleTxRate').value = c ? c.exchange_rate : 1.0;
}

async function submitSimpleTransaction(event) {
  event.preventDefault();
  try {
    const editId = document.getElementById('simpleTxEditId').value;
    const payload = {
      tx_type: document.getElementById('simpleTxType').value,
      date: document.getElementById('simpleTxDate').value,
      amount: parseFloat(document.getElementById('simpleTxAmount').value),
      payment_account_id: Number(document.getElementById('simpleTxPaymentAccount').value),
      category_account_id: Number(document.getElementById('simpleTxCategoryAccount').value),
      payee: document.getElementById('simpleTxPayee').value,
      reference: document.getElementById('simpleTxRef').value,
      memo: document.getElementById('simpleTxMemo').value,
      currency: document.getElementById('simpleTxCurrency').value,
      exchange_rate: parseFloat(document.getElementById('simpleTxRate').value || '1'),
      is_tax_deductible: document.getElementById('simpleTxTaxDeductible').checked ? 1 : 0
    };

    if (editId) {
      await apiFetch(`/api/transactions/simple/${editId}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      showToast('Transaction updated in General Ledger!');
    } else {
      await apiFetch('/api/transactions/simple', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showToast('Transaction recorded with balanced Debits & Credits!');
    }

    closeModal('simpleTxModal');
    document.getElementById('simpleTxEditId').value = '';
    document.getElementById('simpleTxAmount').value = '';
    document.getElementById('simpleTxPayee').value = '';
    document.getElementById('simpleTxMemo').value = '';
    await loadBootstrap();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Multi-Line Double-Entry Journal Modal (New & Edit)
function openJournalEntryModal() {
  const editEl = document.getElementById('jeEditId');
  if (editEl) editEl.value = '';
  const titleEl = document.getElementById('journalModalTitle');
  if (titleEl) titleEl.textContent = 'New Double-Entry Journal Entry';
  const btnEl = document.getElementById('journalSubmitBtn');
  if (btnEl) btnEl.textContent = 'Post Journal Entry';

  document.getElementById('jeDate').value = new Date().toISOString().slice(0, 10);
  document.getElementById('jePayee').value = '';
  document.getElementById('jeMemo').value = '';
  document.getElementById('jeLinesBody').innerHTML = '';
  addJournalModalLine();
  addJournalModalLine();
  updateJournalModalTotals();
  openModal('journalModal');
}

function openEditJournalEntryModal(entryId) {
  const tx = APP.transactions.find((t) => t.id === Number(entryId));
  if (!tx) return;

  const editEl = document.getElementById('jeEditId');
  if (editEl) editEl.value = String(tx.id);
  const titleEl = document.getElementById('journalModalTitle');
  if (titleEl) titleEl.textContent = `Edit Double-Entry Journal (${tx.entry_number})`;
  const btnEl = document.getElementById('journalSubmitBtn');
  if (btnEl) btnEl.textContent = 'Update Journal Entry';

  document.getElementById('jeDate').value = tx.date || '2026-10-19';
  document.getElementById('jePayee').value = tx.payee || '';
  document.getElementById('jeMemo').value = tx.memo || tx.payee || 'Journal Entry';

  const tbody = document.getElementById('jeLinesBody');
  tbody.innerHTML = '';
  const lines = tx.lines && tx.lines.length > 0 ? tx.lines : [];
  if (lines.length === 0) {
    addJournalModalLine();
    addJournalModalLine();
  } else {
    lines.forEach((l) => {
      addJournalModalLine({
        account_id: l.account_id,
        description: l.description || tx.memo || '',
        debit: Number(l.debit || 0),
        credit: Number(l.credit || 0),
        reconciled_status: l.reconciled_status || 'UNRECONCILED'
      });
    });
  }
  updateJournalModalTotals();
  openModal('journalModal');
}

function addJournalModalLine(prefill = null) {
  const tbody = document.getElementById('jeLinesBody');
  const tr = document.createElement('tr');
  if (prefill && prefill.reconciled_status) {
    tr.dataset.reconciledStatus = prefill.reconciled_status;
  }
  tr.innerHTML = `
    <td class="py-2 px-2">
      <select class="je-line-acc w-full px-2 py-1.5 rounded border border-slate-300 bg-white text-xs">
        ${APP.accounts.map((a) => `<option value="${a.id}" ${prefill && Number(prefill.account_id) === a.id ? 'selected' : ''}>${escapeHtml(a.code)} - ${escapeHtml(a.name)} (${a.type})</option>`).join('')}
      </select>
    </td>
    <td class="py-2 px-2">
      <input type="text" placeholder="Line description" value="${prefill ? escapeHtml(prefill.description || '') : ''}" class="je-line-desc w-full px-2 py-1.5 rounded border border-slate-300 text-xs" />
    </td>
    <td class="py-2 px-2">
      <input type="number" step="0.01" min="0" placeholder="0.00" value="${prefill && prefill.debit > 0 ? Number(prefill.debit).toFixed(2) : ''}" oninput="onJeDebitCreditInput(this, 'debit')" class="je-line-debit w-full px-2 py-1.5 rounded border border-slate-300 text-right font-mono text-xs" />
    </td>
    <td class="py-2 px-2">
      <input type="number" step="0.01" min="0" placeholder="0.00" value="${prefill && prefill.credit > 0 ? Number(prefill.credit).toFixed(2) : ''}" oninput="onJeDebitCreditInput(this, 'credit')" class="je-line-credit w-full px-2 py-1.5 rounded border border-slate-300 text-right font-mono text-xs" />
    </td>
    <td class="py-2 px-2 text-center">
      <button type="button" onclick="this.closest('tr').remove(); updateJournalModalTotals();" class="text-slate-400 hover:text-rose-600">&times;</button>
    </td>
  `;
  tbody.appendChild(tr);
}

function onJeDebitCreditInput(input, side) {
  const tr = input.closest('tr');
  if (side === 'debit' && parseFloat(input.value) > 0) {
    tr.querySelector('.je-line-credit').value = '';
  } else if (side === 'credit' && parseFloat(input.value) > 0) {
    tr.querySelector('.je-line-debit').value = '';
  }
  updateJournalModalTotals();
}

function updateJournalModalTotals() {
  let dSum = 0;
  let cSum = 0;
  document.querySelectorAll('#jeLinesBody tr').forEach((tr) => {
    dSum += parseFloat(tr.querySelector('.je-line-debit').value || '0');
    cSum += parseFloat(tr.querySelector('.je-line-credit').value || '0');
  });
  document.getElementById('jeTotalDebit').textContent = fmtMoney(dSum);
  document.getElementById('jeTotalCredit').textContent = fmtMoney(cSum);

  const diff = Math.round((dSum - cSum) * 100) / 100;
  const statusEl = document.getElementById('jeBalanceStatus');
  if (Math.abs(diff) < 0.01 && dSum > 0) {
    statusEl.textContent = `✓ Balanced (Debits = Credits = ${fmtMoney(dSum)})`;
    statusEl.className = 'font-mono text-xs font-semibold text-emerald-600';
  } else {
    statusEl.textContent = `Out of balance by ${fmtMoney(Math.abs(diff))}`;
    statusEl.className = 'font-mono text-xs font-semibold text-rose-600';
  }
}

async function submitJournalEntryModal(event) {
  event.preventDefault();
  try {
    const editId = document.getElementById('jeEditId')?.value || '';
    const existingTx = editId ? APP.transactions.find((t) => t.id === Number(editId)) : null;
    const lines = [];
    document.querySelectorAll('#jeLinesBody tr').forEach((tr) => {
      const account_id = Number(tr.querySelector('.je-line-acc').value);
      const description = tr.querySelector('.je-line-desc').value;
      const debit = parseFloat(tr.querySelector('.je-line-debit').value || '0');
      const credit = parseFloat(tr.querySelector('.je-line-credit').value || '0');
      const reconciled_status = tr.dataset.reconciledStatus || 'UNRECONCILED';
      if (debit > 0 || credit > 0) {
        lines.push({ account_id, description, debit, credit, reconciled_status });
      }
    });

    const payload = {
      date: document.getElementById('jeDate').value,
      payee: document.getElementById('jePayee').value,
      memo: document.getElementById('jeMemo').value,
      source_type: existingTx ? existingTx.source_type : 'JOURNAL',
      lines
    };

    if (editId) {
      await apiFetch(`/api/journal-entries/${editId}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      showToast(`Journal Entry ${existingTx ? existingTx.entry_number : ''} updated!`);
    } else {
      await apiFetch('/api/journal-entries', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showToast('Double-Entry Journal Entry posted!');
    }

    if (document.getElementById('jeEditId')) document.getElementById('jeEditId').value = '';
    closeModal('journalModal');
    await loadBootstrap();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// New / Edit Account Modal (with custom Opening Balance Date / As-Of Date)
function openAccountModal() {
  document.getElementById('accEditId').value = '';
  document.getElementById('accountModalTitle').textContent = 'Add Account to Chart of Accounts';
  document.getElementById('accountModalSubmitBtn').textContent = 'Create Account';
  document.getElementById('lblAccOpeningBal').textContent = 'Opening Balance ($)';
  document.getElementById('accCode').value = '';
  document.getElementById('accName').value = '';
  document.getElementById('accType').value = 'ASSET';
  document.getElementById('accSubtype').value = 'BANK';
  document.getElementById('accOpeningBal').value = '0';
  if (document.getElementById('accOpeningDate')) {
    document.getElementById('accOpeningDate').value = '2026-01-01';
  }
  document.getElementById('accTaxCat').value = '';
  document.getElementById('accDesc').value = '';
  openModal('accountModal');
}

function openEditAccountModal(accountId) {
  const acc = APP.accounts.find((a) => a.id === Number(accountId));
  if (!acc) return;

  document.getElementById('accEditId').value = String(acc.id);
  document.getElementById('accountModalTitle').textContent = `Edit Account (${acc.code} — ${acc.name})`;
  document.getElementById('accountModalSubmitBtn').textContent = 'Save Account Changes';
  document.getElementById('lblAccOpeningBal').textContent = 'Opening / Target Balance ($)';

  document.getElementById('accCode').value = acc.code || '';
  document.getElementById('accName').value = acc.name || '';
  document.getElementById('accType').value = acc.type || 'ASSET';

  const subSelect = document.getElementById('accSubtype');
  if (acc.subtype && ![...subSelect.options].some((o) => o.value === acc.subtype)) {
    subSelect.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(acc.subtype)}">${escapeHtml(acc.subtype)}</option>`);
  }
  subSelect.value = acc.subtype || 'BANK';

  document.getElementById('accOpeningBal').value = Number(acc.balance || 0).toFixed(2);
  if (document.getElementById('accOpeningDate')) {
    document.getElementById('accOpeningDate').value = acc.opening_date || '2026-01-01';
  }
  document.getElementById('accTaxCat').value = acc.tax_category || '';
  document.getElementById('accDesc').value = acc.description || '';

  openModal('accountModal');
}

async function submitNewAccount(event) {
  event.preventDefault();
  try {
    const editId = document.getElementById('accEditId').value;
    const payload = {
      code: document.getElementById('accCode').value.trim(),
      name: document.getElementById('accName').value.trim(),
      type: document.getElementById('accType').value,
      subtype: document.getElementById('accSubtype').value,
      opening_balance: parseFloat(document.getElementById('accOpeningBal').value || '0'),
      opening_date: document.getElementById('accOpeningDate')?.value || '2026-01-01',
      tax_category: document.getElementById('accTaxCat').value.trim(),
      description: document.getElementById('accDesc').value.trim()
    };

    if (editId) {
      await apiFetch(`/api/accounts/${editId}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      showToast(`Account "${payload.code} - ${payload.name}" updated (Opening Date: ${payload.opening_date})!`);
    } else {
      await apiFetch('/api/accounts', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showToast(`Account "${payload.code} - ${payload.name}" added (Opening Date: ${payload.opening_date})!`);
    }

    closeModal('accountModal');
    document.getElementById('accEditId').value = '';
    event.target.reset();
    await loadBootstrap();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ================= IMPORT / BULK SET OPENING BALANCES MODAL =================
function openOpeningBalanceModal() {
  const defaultDate = document.getElementById('obDefaultDate')?.value || '2026-01-01';
  const eligible = APP.accounts.filter((a) => ['ASSET', 'LIABILITY', 'EQUITY'].includes(a.type) && a.code !== '3010');
  renderOpeningBalancesGrid(eligible.map((a) => ({
    account_id: a.id,
    code: a.code,
    name: a.name,
    type: a.type,
    subtype: a.subtype || a.type,
    opening_date: a.opening_date || defaultDate,
    opening_balance: Number(a.balance || 0).toFixed(2)
  })));
  openModal('openingBalanceModal');
}

function renderOpeningBalancesGrid(rows) {
  const tbody = document.getElementById('openingBalancesGridBody');
  if (!tbody) return;
  tbody.innerHTML = rows.map((r) => `
    <tr class="hover:bg-slate-50" data-acc-id="${r.account_id || ''}" data-code="${escapeHtml(r.code)}" data-name="${escapeHtml(r.name)}" data-type="${escapeHtml(r.type)}" data-subtype="${escapeHtml(r.subtype || r.type)}">
      <td class="py-2 px-3 font-mono font-bold text-slate-900">${escapeHtml(r.code)}</td>
      <td class="py-2 px-3 font-semibold text-slate-800">${escapeHtml(r.name)}</td>
      <td class="py-2 px-3 text-[11px] font-mono text-slate-500">${escapeHtml(r.type)} &bull; ${escapeHtml(r.subtype || r.type)}</td>
      <td class="py-2 px-3">
        <input type="date" value="${escapeHtml(r.opening_date || '2026-01-01')}" class="ob-row-date px-2.5 py-1.5 rounded border border-slate-300 bg-white font-mono text-xs" />
      </td>
      <td class="py-2 px-3 text-right">
        <input type="number" step="0.01" value="${escapeHtml(String(r.opening_balance ?? '0.00'))}" class="ob-row-bal w-36 px-2.5 py-1.5 rounded border border-slate-300 bg-white font-mono text-right font-semibold text-xs" />
      </td>
    </tr>
  `).join('');
}

function applyDefaultDateToAllOpeningRows(dateVal) {
  if (!dateVal) return;
  document.querySelectorAll('#openingBalancesGridBody .ob-row-date').forEach((inp) => {
    inp.value = dateVal;
  });
}

async function handleOpeningBalanceCSVSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const csvText = await file.text();
    const defaultDate = document.getElementById('obDefaultDate')?.value || '2026-01-01';
    const res = await apiFetch('/api/accounts/opening-balances-import', {
      method: 'POST',
      body: JSON.stringify({
        csvText,
        defaultDate,
        replaceExistingOpening: true
      })
    });
    event.target.value = '';
    closeModal('openingBalanceModal');
    showToast(`Imported opening balances from CSV (${res.updatedCount} updated, ${res.createdCount || 0} created)!`);
    await loadBootstrap();
  } catch (err) {
    showToast('Opening balance CSV import failed: ' + err.message, 'error');
  }
}

function loadSampleOpeningBalances() {
  const defaultDate = document.getElementById('obDefaultDate')?.value || '2026-01-01';
  const sampleMap = {
    '1010': '18500.00',
    '1020': '45000.00',
    '1030': '112000.00',
    '1200': '0.00',
    '1510': '580000.00',
    '2010': '1450.00',
    '2100': '0.00',
    '2510': '342000.00'
  };
  document.querySelectorAll('#openingBalancesGridBody tr').forEach((tr) => {
    const code = tr.dataset.code;
    const balInput = tr.querySelector('.ob-row-bal');
    const dateInput = tr.querySelector('.ob-row-date');
    if (balInput && sampleMap[code] !== undefined) {
      balInput.value = sampleMap[code];
    }
    if (dateInput) {
      dateInput.value = defaultDate;
    }
  });
  showToast('Sample Opening Balances loaded into grid! Click "Save & Import Opening Balances" to apply.');
}

async function submitOpeningBalancesModal() {
  try {
    const defaultDate = document.getElementById('obDefaultDate')?.value || '2026-01-01';
    const rows = [];
    document.querySelectorAll('#openingBalancesGridBody tr').forEach((tr) => {
      rows.push({
        account_id: tr.dataset.accId ? Number(tr.dataset.accId) : undefined,
        code: tr.dataset.code,
        name: tr.dataset.name,
        type: tr.dataset.type,
        subtype: tr.dataset.subtype,
        opening_date: tr.querySelector('.ob-row-date')?.value || defaultDate,
        opening_balance: parseFloat(tr.querySelector('.ob-row-bal')?.value || '0')
      });
    });

    const res = await apiFetch('/api/accounts/opening-balances-import', {
      method: 'POST',
      body: JSON.stringify({
        rows,
        defaultDate,
        replaceExistingOpening: true
      })
    });
    closeModal('openingBalanceModal');
    showToast(`Saved opening balances for ${res.updatedCount} account(s) with custom As-Of Dates!`);
    await loadBootstrap();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function openDeleteAccountModal(accountId) {
  const acc = APP.accounts.find((a) => a.id === Number(accountId));
  if (!acc) return;

  document.getElementById('delAccId').value = String(acc.id);
  document.getElementById('delAccTargetLabel').textContent = `${acc.code} — ${acc.name} (${acc.type})`;

  const lineCount = Number(acc.line_count || 0);
  const usageEl = document.getElementById('delAccUsageInfo');
  const reassignSection = document.getElementById('delAccReassignSection');
  const reassignSelect = document.getElementById('delAccReassignSelect');

  const otherAccounts = APP.accounts
    .filter((a) => a.id !== acc.id)
    .sort((a, b) => {
      if (a.type === acc.type && b.type !== acc.type) return -1;
      if (a.type !== acc.type && b.type === acc.type) return 1;
      return String(a.code).localeCompare(String(b.code));
    });

  reassignSelect.innerHTML =
    `<option value="">Delete account and remove its ${lineCount} associated journal line(s)</option>` +
    otherAccounts.map((o) => `<option value="${o.id}">Reassign transactions &amp; rules to: ${escapeHtml(o.code)} - ${escapeHtml(o.name)} (${o.type})</option>`).join('');

  if (lineCount > 0) {
    usageEl.innerHTML = `Current Balance: <strong class="font-mono">${fmtMoney(acc.balance)}</strong> &bull; Used in <strong>${lineCount}</strong> ledger line(s).`;
    reassignSection.classList.remove('hidden');
  } else {
    usageEl.textContent = 'This account has 0 transactions and can be deleted cleanly.';
    reassignSection.classList.add('hidden');
    reassignSelect.value = '';
  }

  openModal('deleteAccountModal');
}

async function confirmDeleteAccount() {
  try {
    const accId = Number(document.getElementById('delAccId').value);
    if (!accId) return;
    const targetAcc = APP.accounts.find((a) => a.id === accId);
    const reassignTo = document.getElementById('delAccReassignSelect').value;
    const url = reassignTo
      ? `/api/accounts/${accId}?reassignTo=${encodeURIComponent(reassignTo)}`
      : `/api/accounts/${accId}`;

    const res = await apiFetch(url, { method: 'DELETE' });
    const delInfo = res.deleted || targetAcc || { code: '', name: 'Account' };
    closeModal('deleteAccountModal');
    showToast(`Deleted account "${delInfo.code} - ${delInfo.name}" from Chart of Accounts!`);
    await loadBootstrap();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', () => {
  loadBootstrap();
});
