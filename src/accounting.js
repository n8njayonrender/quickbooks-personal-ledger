const { db, round2, makeImportHash, createJournalEntry, createSimpleTransaction } = require('./db');

/**
 * Returns normal balance of an account given total debits and credits
 */
function computeNormalBalance(accountType, debitSum, creditSum) {
  const d = Number(debitSum) || 0;
  const c = Number(creditSum) || 0;
  if (accountType === 'ASSET' || accountType === 'EXPENSE') {
    return round2(d - c);
  }
  return round2(c - d);
}

/**
 * Get all accounts with their current balances (optionally up to asOfDate)
 */
function getAccountsWithBalances(asOfDate = null) {
  let sql = `
    SELECT
      a.*,
      COALESCE(SUM(CASE WHEN (? IS NULL OR je.date <= ?) THEN jl.debit ELSE 0 END), 0) AS total_debit,
      COALESCE(SUM(CASE WHEN (? IS NULL OR je.date <= ?) THEN jl.credit ELSE 0 END), 0) AS total_credit,
      MIN(CASE WHEN je.source_type = 'OPENING_BALANCE' THEN je.date ELSE NULL END) AS opening_date,
      COUNT(jl.id) AS line_count
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id
    LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id
    GROUP BY a.id
    ORDER BY a.code ASC
  `;
  const rows = db.prepare(sql).all(asOfDate, asOfDate, asOfDate, asOfDate);
  return rows.map((r) => ({
    ...r,
    opening_date: r.opening_date || '2026-01-01',
    total_debit: round2(r.total_debit),
    total_credit: round2(r.total_credit),
    balance: computeNormalBalance(r.type, r.total_debit, r.total_credit)
  }));
}

/**
 * Profit & Loss (Income Statement) Report for [startDate, endDate]
 */
function getProfitAndLoss(startDate, endDate) {
  const sql = `
    SELECT
      a.id, a.code, a.name, a.type, a.subtype, a.tax_category,
      COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.debit ELSE 0 END), 0) AS total_debit,
      COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.credit ELSE 0 END), 0) AS total_credit
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id
    LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id
      AND je.date >= ? AND je.date <= ?
    WHERE a.type IN ('INCOME', 'EXPENSE')
    GROUP BY a.id
    ORDER BY a.code ASC
  `;
  const rows = db.prepare(sql).all(startDate, endDate);

  const incomeAccounts = [];
  const expenseAccounts = [];
  let totalIncome = 0;
  let totalExpenses = 0;

  for (const r of rows) {
    const amount = computeNormalBalance(r.type, r.total_debit, r.total_credit);
    if (r.type === 'INCOME') {
      if (amount !== 0 || r.total_debit > 0 || r.total_credit > 0) {
        incomeAccounts.push({ ...r, amount });
      }
      totalIncome = round2(totalIncome + amount);
    } else if (r.type === 'EXPENSE') {
      if (amount !== 0 || r.total_debit > 0 || r.total_credit > 0) {
        expenseAccounts.push({ ...r, amount });
      }
      totalExpenses = round2(totalExpenses + amount);
    }
  }

  const netIncome = round2(totalIncome - totalExpenses);
  const savingsRate = totalIncome > 0 ? round2((netIncome / totalIncome) * 100) : 0;

  return {
    startDate,
    endDate,
    incomeAccounts,
    expenseAccounts,
    totalIncome,
    totalExpenses,
    netIncome,
    savingsRate
  };
}

/**
 * Balance Sheet Report as of asOfDate
 */
function getBalanceSheet(asOfDate) {
  const accounts = getAccountsWithBalances(asOfDate);

  const assets = accounts.filter((a) => a.type === 'ASSET');
  const liabilities = accounts.filter((a) => a.type === 'LIABILITY');
  const equityAccounts = accounts.filter((a) => a.type === 'EQUITY');

  const totalAssets = round2(assets.reduce((s, a) => s + a.balance, 0));
  const totalLiabilities = round2(liabilities.reduce((s, a) => s + a.balance, 0));
  const baseEquity = round2(equityAccounts.reduce((s, a) => s + a.balance, 0));

  // Calculate cumulative Net Income (Retained Earnings) up to asOfDate
  const incomeTotal = round2(
    accounts.filter((a) => a.type === 'INCOME').reduce((s, a) => s + a.balance, 0)
  );
  const expenseTotal = round2(
    accounts.filter((a) => a.type === 'EXPENSE').reduce((s, a) => s + a.balance, 0)
  );
  const retainedEarnings = round2(incomeTotal - expenseTotal);

  const totalEquity = round2(baseEquity + retainedEarnings);
  const totalLiabilitiesAndEquity = round2(totalLiabilities + totalEquity);
  const netWorth = round2(totalAssets - totalLiabilities);

  return {
    asOfDate,
    assets,
    liabilities,
    equityAccounts: [
      ...equityAccounts,
      {
        id: 'RETAINED_EARNINGS',
        code: '3900',
        name: 'Retained Earnings / Cumulative Net Savings',
        type: 'EQUITY',
        subtype: 'EQUITY',
        balance: retainedEarnings
      }
    ],
    totalAssets,
    totalLiabilities,
    totalEquity,
    totalLiabilitiesAndEquity,
    netWorth,
    isBalanced: Math.abs(totalAssets - totalLiabilitiesAndEquity) < 0.01
  };
}

/**
 * Trial Balance as of asOfDate
 */
function getTrialBalance(asOfDate) {
  const accounts = getAccountsWithBalances(asOfDate);
  let totalDebit = 0;
  let totalCredit = 0;

  const rows = accounts
    .filter((a) => a.total_debit > 0 || a.total_credit > 0)
    .map((a) => {
      const net = round2(a.total_debit - a.total_credit);
      const debitCol = net > 0 ? net : 0;
      const creditCol = net < 0 ? Math.abs(net) : 0;
      totalDebit = round2(totalDebit + debitCol);
      totalCredit = round2(totalCredit + creditCol);
      return {
        id: a.id,
        code: a.code,
        name: a.name,
        type: a.type,
        raw_debit: a.total_debit,
        raw_credit: a.total_credit,
        debit_balance: debitCol,
        credit_balance: creditCol
      };
    });

  return {
    asOfDate,
    rows,
    totalDebit,
    totalCredit,
    isBalanced: Math.abs(totalDebit - totalCredit) < 0.01
  };
}

/**
 * Cash Flow Statement for [startDate, endDate]
 */
function getCashFlowStatement(startDate, endDate) {
  // Beginning cash in BANK accounts strictly before startDate
  const begRow = db.prepare(`
    SELECT
      COALESCE(SUM(jl.debit - jl.credit), 0) AS beg_cash
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE a.type = 'ASSET' AND a.subtype = 'BANK' AND je.date < ?
  `).get(startDate);
  const beginningCash = round2(begRow.beg_cash || 0);

  // Ending cash in BANK accounts up to endDate
  const endRow = db.prepare(`
    SELECT
      COALESCE(SUM(jl.debit - jl.credit), 0) AS end_cash
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE a.type = 'ASSET' AND a.subtype = 'BANK' AND je.date <= ?
  `).get(endDate);
  const endingCash = round2(endRow.end_cash || 0);

  // Classify non-bank lines in entries that occurred during [startDate, endDate]
  const pnl = getProfitAndLoss(startDate, endDate);
  const operatingCashFlow = pnl.netIncome;

  // Investing activities: changes in INVESTMENT and FIXED_ASSET accounts
  const invRow = db.prepare(`
    SELECT
      COALESCE(SUM(jl.credit - jl.debit), 0) AS net_investing
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE a.subtype IN ('INVESTMENT', 'FIXED_ASSET')
      AND je.date >= ? AND je.date <= ?
      AND je.source_type != 'OPENING_BALANCE'
  `).get(startDate, endDate);
  const investingCashFlow = round2(invRow.net_investing || 0);

  // Financing / Credit & Debt / Opening Equity activities
  const netCashChange = round2(endingCash - beginningCash);
  const financingAndWorkingCapital = round2(netCashChange - operatingCashFlow - investingCashFlow);

  return {
    startDate,
    endDate,
    beginningCash,
    operatingCashFlow,
    investingCashFlow,
    financingAndWorkingCapital,
    netCashChange,
    endingCash
  };
}

/**
 * Tax Summary Report for [startDate, endDate]
 */
function getTaxSummary(startDate, endDate) {
  const taxRateSetting = db.prepare("SELECT value FROM settings WHERE key = 'tax_rate_estimate'").get();
  const estTaxRate = Number(taxRateSetting ? taxRateSetting.value : 24) || 24;

  // All Income lines
  const incomeRows = db.prepare(`
    SELECT
      a.code, a.name, a.tax_category,
      COALESCE(SUM(jl.credit - jl.debit), 0) AS amount
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE a.type = 'INCOME' AND je.date >= ? AND je.date <= ?
    GROUP BY a.id
    HAVING amount != 0
    ORDER BY a.code ASC
  `).all(startDate, endDate);

  // Tax-deductible expense transactions
  const deductibleRows = db.prepare(`
    SELECT
      je.id AS entry_id, je.entry_number, je.date, je.payee, je.memo,
      a.code AS account_code, a.name AS account_name, a.tax_category,
      jl.debit AS amount
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE a.type = 'EXPENSE'
      AND (je.is_tax_deductible = 1 OR a.subtype = 'TAX_EXPENSE')
      AND jl.debit > 0
      AND je.date >= ? AND je.date <= ?
    ORDER BY je.date DESC
  `).all(startDate, endDate);

  const totalTaxableIncome = round2(incomeRows.reduce((s, r) => s + r.amount, 0));
  const taxesAlreadyPaid = round2(
    deductibleRows
      .filter((r) => r.account_code === '5200')
      .reduce((s, r) => s + r.amount, 0)
  );
  const businessAndItemizedDeductions = round2(
    deductibleRows
      .filter((r) => r.account_code !== '5200')
      .reduce((s, r) => s + r.amount, 0)
  );

  const netTaxableBase = Math.max(0, round2(totalTaxableIncome - businessAndItemizedDeductions));
  const estimatedTaxLiability = round2(netTaxableBase * (estTaxRate / 100));
  const estimatedRemainingTaxDue = round2(estimatedTaxLiability - taxesAlreadyPaid);

  return {
    startDate,
    endDate,
    estTaxRate,
    incomeRows: incomeRows.map((r) => ({ ...r, amount: round2(r.amount) })),
    deductibleRows: deductibleRows.map((r) => ({ ...r, amount: round2(r.amount) })),
    totalTaxableIncome,
    businessAndItemizedDeductions,
    netTaxableBase,
    taxesAlreadyPaid,
    estimatedTaxLiability,
    estimatedRemainingTaxDue
  };
}

/**
 * Monthly Trend Data (last 6 months or custom) for Dashboard charts
 */
function getMonthlyTrends() {
  const rows = db.prepare(`
    SELECT
      substr(je.date, 1, 7) AS month,
      SUM(CASE WHEN a.type = 'INCOME' THEN (jl.credit - jl.debit) ELSE 0 END) AS income,
      SUM(CASE WHEN a.type = 'EXPENSE' THEN (jl.debit - jl.credit) ELSE 0 END) AS expense
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE a.type IN ('INCOME', 'EXPENSE')
    GROUP BY substr(je.date, 1, 7)
    ORDER BY month ASC
  `).all();

  return rows.map((r) => ({
    month: r.month,
    income: round2(r.income),
    expense: round2(r.expense),
    net: round2(r.income - r.expense)
  }));
}

/**
 * RFC-4180 compliant CSV parser
 */
function parseCSVText(csvText) {
  const text = String(csvText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let currentRow = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        currentField += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        currentField += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        currentRow.push(currentField.trim());
        currentField = '';
      } else if (ch === '\n') {
        currentRow.push(currentField.trim());
        if (currentRow.some((cell) => cell !== '')) {
          rows.push(currentRow);
        }
        currentRow = [];
        currentField = '';
      } else {
        currentField += ch;
      }
    }
  }
  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some((cell) => cell !== '')) {
      rows.push(currentRow);
    }
  }
  return rows;
}

/**
 * Normalize date strings (YYYY-MM-DD, MM/DD/YYYY, DD/MM/YYYY, DD-MMM-YYYY) into YYYY-MM-DD
 */
function normalizeDate(raw) {
  const str = String(raw || '').trim();
  if (!str) return new Date().toISOString().slice(0, 10);

  // YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
  }

  // DD/MM/YYYY or MM/DD/YYYY
  const slashMatch = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (slashMatch) {
    let p1 = parseInt(slashMatch[1], 10);
    let p2 = parseInt(slashMatch[2], 10);
    let yr = slashMatch[3];
    if (yr.length === 2) yr = '20' + yr;
    // If first part > 12, it is definitely DD/MM/YYYY
    let month = p1;
    let day = p2;
    if (p1 > 12) {
      day = p1;
      month = p2;
    }
    return `${yr}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

/**
 * Parse currency string like "$1,234.56", "(45.20)", "-$89.00" into float
 */
function parseAmount(raw) {
  if (raw === null || raw === undefined) return 0;
  let str = String(raw).trim();
  if (!str) return 0;
  let isNegative = false;
  if (str.startsWith('(') && str.endsWith(')')) {
    isNegative = true;
    str = str.slice(1, -1);
  }
  if (str.includes('-')) {
    isNegative = true;
  }
  const cleaned = str.replace(/[^0-9.]/g, '');
  const val = parseFloat(cleaned);
  if (isNaN(val)) return 0;
  return isNegative ? -Math.abs(val) : val;
}

/**
 * Match a transaction against active categorization rules
 */
function matchCategorizationRule(description, payee, isInflow) {
  const rules = db.prepare(`
    SELECT r.*, a.name AS account_name, a.code AS account_code, a.type AS account_type
    FROM categorization_rules r
    JOIN accounts a ON a.id = r.target_account_id
    WHERE r.is_active = 1
    ORDER BY r.priority ASC, r.id ASC
  `).all();

  const descUpper = String(description || '').toUpperCase();
  const payeeUpper = String(payee || '').toUpperCase();
  const combinedUpper = `${descUpper} ${payeeUpper}`.trim();

  for (const rule of rules) {
    if (rule.transaction_type === 'INFLOW' && !isInflow) continue;
    if (rule.transaction_type === 'OUTFLOW' && isInflow) continue;

    let targetText = combinedUpper;
    if (rule.match_field === 'DESCRIPTION') targetText = descUpper;
    if (rule.match_field === 'PAYEE') targetText = payeeUpper;

    const matchVal = String(rule.match_value || '').toUpperCase();
    if (!matchVal) continue;

    let matched = false;
    if (rule.match_type === 'CONTAINS') {
      matched = targetText.includes(matchVal);
    } else if (rule.match_type === 'STARTS_WITH') {
      matched = targetText.startsWith(matchVal);
    } else if (rule.match_type === 'EXACT') {
      matched = targetText === matchVal;
    } else if (rule.match_type === 'REGEX') {
      try {
        matched = new RegExp(rule.match_value, 'i').test(targetText);
      } catch (_) {
        matched = false;
      }
    }

    if (matched) {
      return rule;
    }
  }
  return null;
}

/**
 * Auto-detect column indices from CSV header row
 */
function autoDetectColumns(headers, dataRows = []) {
  const mapping = {
    dateCol: -1,
    descriptionCol: -1,
    payeeCol: -1,
    amountCol: -1,
    debitCol: -1,
    creditCol: -1,
    typeCol: -1,
    referenceCol: -1,
    categoryCol: -1,
    accountCol: -1
  };

  headers.forEach((h, idx) => {
    const lower = String(h || '').toLowerCase().trim();
    if (mapping.dateCol === -1 && (lower.includes('date') || lower === 'posted' || lower === 'timestamp')) {
      mapping.dateCol = idx;
    } else if (mapping.categoryCol === -1 && (
      lower.includes('cat') || lower.includes('offset') || lower.includes('class') ||
      lower.includes('gl') || lower.includes('ledger') || lower.includes('coa') ||
      lower.includes('chart') || lower.includes('bucket') || lower.includes('group') ||
      lower.includes('head') || lower.includes('dept') || lower.includes('department') ||
      lower === 'expense' || lower === 'income' || lower.includes('account name') || lower.includes('account code')
    )) {
      mapping.categoryCol = idx;
    } else if (mapping.descriptionCol === -1 && (lower.includes('desc') || lower.includes('memo') || lower.includes('narrative') || lower.includes('details') || lower.includes('particulars') || lower === 'note' || lower === 'notes')) {
      mapping.descriptionCol = idx;
    } else if (mapping.payeeCol === -1 && (lower.includes('payee') || lower.includes('merchant') || lower.includes('vendor') || lower.includes('counterparty') || lower === 'name')) {
      mapping.payeeCol = idx;
    } else if (mapping.amountCol === -1 && (lower === 'amount' || lower.includes('amount') || lower === 'value' || lower === 'net' || lower === 'total')) {
      mapping.amountCol = idx;
    } else if (mapping.debitCol === -1 && (lower.includes('debit') || lower.includes('withdrawal') || lower.includes('outflow') || lower.includes('money out') || lower === 'spent')) {
      mapping.debitCol = idx;
    } else if (mapping.creditCol === -1 && (lower.includes('credit') || lower.includes('deposit') || lower.includes('inflow') || lower.includes('money in') || lower === 'received')) {
      mapping.creditCol = idx;
    } else if (mapping.typeCol === -1 && (lower === 'type' || lower === 'transaction type' || lower === 'dr/cr')) {
      mapping.typeCol = idx;
    } else if (mapping.referenceCol === -1 && (lower.includes('ref') || lower.includes('check') || lower.includes('id') || lower.includes('number'))) {
      mapping.referenceCol = idx;
    } else if (mapping.accountCol === -1 && (lower === 'account' || lower.includes('bank account') || lower.includes('payment account') || lower.includes('source account'))) {
      mapping.accountCol = idx;
    }
  });

  // Content-based heuristic: if categoryCol is still -1, check if typeCol or accountCol actually holds category names
  if (mapping.categoryCol === -1 && Array.isArray(dataRows) && dataRows.length > 0) {
    const txTypeKeywords = new Set(['DEBIT', 'CREDIT', 'DR', 'CR', 'EXPENSE', 'INCOME', 'TRANSFER', 'WITHDRAWAL', 'DEPOSIT', 'CHECK', 'POS', 'ACH', 'PAYMENT']);
    if (mapping.typeCol >= 0) {
      const sampleVals = dataRows.slice(0, 10).map((r) => String(r[mapping.typeCol] || '').trim().toUpperCase()).filter(Boolean);
      if (sampleVals.length > 0 && sampleVals.some((v) => !txTypeKeywords.has(v))) {
        mapping.categoryCol = mapping.typeCol;
        mapping.typeCol = -1;
      }
    }
  }

  if (mapping.dateCol === -1 && headers.length > 0) mapping.dateCol = 0;
  if (mapping.descriptionCol === -1 && headers.length > 1) mapping.descriptionCol = 1;
  if (mapping.amountCol === -1 && mapping.debitCol === -1 && headers.length > 2) {
    // Pick last numeric-looking column or col 2
    let foundAmtCol = -1;
    if (Array.isArray(dataRows) && dataRows.length > 0) {
      for (let c = headers.length - 1; c >= 0; c--) {
        if (c === mapping.dateCol || c === mapping.descriptionCol || c === mapping.payeeCol || c === mapping.categoryCol) continue;
        const val = String(dataRows[0][c] || '').trim();
        if (val && /^-?[$£€¥]?[\d,]+(\.\d+)?$/.test(val.replace(/[()]/g, ''))) {
          foundAmtCol = c;
          break;
        }
      }
    }
    mapping.amountCol = foundAmtCol >= 0 ? foundAmtCol : 2;
  }

  return mapping;
}

const CATEGORY_SYNONYM_PATTERNS = [
  { keywords: ['grocery', 'groceries', 'supermarket', 'supermarkets', 'produce'], matchTerms: ['grocer'] },
  { keywords: ['restaurant', 'restaurants', 'dining', 'cafe', 'coffee', 'takeout', 'food & drink', 'food and drink', 'eating out', 'fast food', 'meals', 'lunch', 'dinner'], matchTerms: ['dining', 'restaurant', 'coffee'] },
  { keywords: ['rent', 'mortgage', 'housing', 'hoa', 'apartment', 'lease'], matchTerms: ['housing', 'rent', 'mortgage'] },
  { keywords: ['utility', 'utilities', 'electric', 'electricity', 'water', 'power', 'internet', 'wifi', 'phone', 'mobile', 'telecom', 'trash', 'sewer', 'cable'], matchTerms: ['utilit', 'internet', 'mobile'] },
  { keywords: ['auto', 'car', 'fuel', 'gas', 'petrol', 'parking', 'toll', 'uber', 'lyft', 'transit', 'transport', 'transportation', 'vehicle', 'commute'], matchTerms: ['transportation', 'fuel', 'transit', 'auto, fuel'] },
  { keywords: ['health', 'healthcare', 'medical', 'doctor', 'dental', 'dentist', 'pharmacy', 'vision', 'hospital', 'clinic'], matchTerms: ['healthcare', 'medical', 'pharmacy'] },
  { keywords: ['insurance', 'premium', 'premiums', 'policy'], matchTerms: ['insurance'] },
  { keywords: ['software', 'subscription', 'subscriptions', 'saas', 'cloud', 'hosting', 'streaming', 'tech', 'technology', 'domain'], matchTerms: ['software', 'subscription', 'cloud'] },
  { keywords: ['travel', 'flight', 'flights', 'airline', 'hotel', 'airbnb', 'lodging', 'vacation', 'holiday'], matchTerms: ['travel', 'flight', 'lodging'] },
  { keywords: ['entertainment', 'movies', 'fitness', 'gym', 'hobbies', 'recreation', 'concert'], matchTerms: ['entertainment', 'fitness'] },
  { keywords: ['office', 'supplies', 'equipment', 'contractor', 'professional', 'legal', 'accounting', 'postage', 'shipping', 'marketing', 'advertising'], matchTerms: ['home office', 'office', 'business'] },
  { keywords: ['tax', 'taxes', 'irs', 'estimated tax', 'state tax', 'federal tax'], matchTerms: ['taxes paid', 'income taxes', '5200'] },
  { keywords: ['salary', 'wages', 'paycheck', 'payroll', 'direct deposit', 'employment', 'bonus', 'stipend'], matchTerms: ['salary', 'payroll', 'wages', '4010'] },
  { keywords: ['freelance', 'consulting', 'client', 'side hustle', 'business income', 'revenue', 'sales', 'commission', 'contract'], matchTerms: ['freelance', 'consulting', '4020'] },
  { keywords: ['dividend', 'dividends', 'interest', 'investment income', 'capital gain', 'yield', 'distribution'], matchTerms: ['dividend', 'interest', '4030'] }
];

function matchAccountByText(allAccounts, rawText, preferInflow = null) {
  if (!rawText) return null;
  const clean = String(rawText).trim();
  if (!clean) return null;
  const lower = clean.toLowerCase();
  if (['uncategorized', 'none', 'n/a', '-', 'null', 'unknown'].includes(lower)) return null;

  const codePrefix = clean.split(/[\s\-—:]/)[0].trim();

  // 1. Exact code or exact name
  const exact = allAccounts.find((a) => String(a.code).toLowerCase() === lower || String(a.code) === codePrefix) ||
                allAccounts.find((a) => a.name.toLowerCase() === lower);
  if (exact) return exact;

  // Pool of candidate accounts (when matching a category, prefer INCOME/EXPENSE accounts first)
  const catPool = preferInflow !== null
    ? allAccounts.filter((a) => a.type === 'INCOME' || a.type === 'EXPENSE')
    : allAccounts;

  // 2. Substring match (only when clean is at least 4 chars)
  if (lower.length >= 4) {
    const sub = catPool.find((a) => a.name.toLowerCase().includes(lower) || lower.includes(a.name.toLowerCase())) ||
                allAccounts.find((a) => a.name.toLowerCase().includes(lower) || lower.includes(a.name.toLowerCase()));
    if (sub) return sub;
  }

  // 3. Whole-word / phrase synonym match
  const inputWords = lower.split(/[^a-z0-9]+/).filter(Boolean);
  for (const syn of CATEGORY_SYNONYM_PATTERNS) {
    const matchedKeyword = syn.keywords.some((k) => (k.includes(' ') ? lower.includes(k) : inputWords.includes(k)));
    if (matchedKeyword) {
      const found = catPool.find((a) =>
        syn.matchTerms.some((t) => String(a.code) === t || a.name.toLowerCase().includes(t))
      );
      if (found) return found;
    }
  }

  // 4. Token word overlap (exact word match on words >= 4 chars)
  const stopWords = new Set(['and', 'the', 'for', 'with', 'from', 'expense', 'expenses', 'income', 'account', 'general', 'other', 'misc', 'care', 'fees', 'payment', 'payments']);
  const tokens = inputWords.filter((w) => w.length >= 4 && !stopWords.has(w));
  if (tokens.length > 0) {
    let bestAcc = null;
    let bestScore = 0;
    for (const a of catPool) {
      if (preferInflow === true && a.type === 'EXPENSE') continue;
      if (preferInflow === false && a.type === 'INCOME') continue;
      const aWords = a.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      let score = 0;
      for (const tok of tokens) {
        if (aWords.includes(tok)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestAcc = a;
      }
    }
    if (bestAcc && bestScore > 0) return bestAcc;
  }

  return null;
}

function getOrCreateCSVCategoryAccount(allAccounts, rawCategoryText, isInflow) {
  const clean = String(rawCategoryText || '').trim();
  if (!clean) return { account: null, created: false };
  const lower = clean.toLowerCase();
  if (['uncategorized', 'none', 'n/a', '-', 'null', 'unknown'].includes(lower)) {
    return { account: null, created: false };
  }

  const matched = matchAccountByText(allAccounts, clean, isInflow);
  if (matched) return { account: matched, created: false };

  // Auto-create a new Category Account in the Chart of Accounts so the CSV category is preserved!
  const targetType = isInflow ? 'INCOME' : 'EXPENSE';
  const targetSubtype = isInflow ? 'OPERATING_INCOME' : 'OPERATING_EXPENSE';
  const baseCode = isInflow ? 4100 : 5100;
  const maxCode = isInflow ? 4890 : 5890;
  const existingCodes = new Set(allAccounts.map((a) => String(a.code)));
  let nextCode = baseCode;
  while (existingCodes.has(String(nextCode)) && nextCode < maxCode) {
    nextCode += 10;
  }
  while (existingCodes.has(String(nextCode))) {
    nextCode += 1;
  }

  const formattedName = clean.charAt(0).toUpperCase() + clean.slice(1);
  const baseCurrRow = db.prepare("SELECT value FROM settings WHERE key = 'base_currency'").get();
  const acctCurr = (baseCurrRow && baseCurrRow.value) ? baseCurrRow.value : 'NZD';
  const info = db.prepare(`
    INSERT INTO accounts (code, name, type, subtype, currency, description, tax_category, is_system, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1)
  `).run(
    String(nextCode),
    formattedName,
    targetType,
    targetSubtype,
    acctCurr,
    `Auto-created from CSV Import category "${formattedName}"`,
    isInflow ? 'Income' : 'Expense'
  );

  const newAcc = {
    id: Number(info.lastInsertRowid),
    code: String(nextCode),
    name: formattedName,
    type: targetType,
    subtype: targetSubtype,
    currency: acctCurr
  };
  allAccounts.push(newAcc);
  return { account: newAcc, created: true };
}

/**
 * Preview CSV import: parses rows, applies column mapping, checks duplicates,
 * and resolves/auto-creates categories from the CSV's Category column + Auto-Categorization Rules.
 */
function previewCSVImport({ csvText, bankAccountId, customMapping = null }) {
  const allRows = parseCSVText(csvText);
  if (allRows.length < 2) {
    throw new Error('CSV file must contain a header row and at least one transaction row.');
  }

  const headers = allRows[0];
  const dataRows = allRows.slice(1);
  const mapping = customMapping || autoDetectColumns(headers, dataRows);

  const defaultExpenseAcc = db.prepare("SELECT * FROM accounts WHERE code IN ('5990', '5999') ORDER BY code ASC LIMIT 1").get() ||
    db.prepare("SELECT * FROM accounts WHERE type = 'EXPENSE' ORDER BY code DESC LIMIT 1").get() ||
    db.prepare('SELECT * FROM accounts ORDER BY code ASC LIMIT 1').get();
  const defaultIncomeAcc = db.prepare("SELECT * FROM accounts WHERE code IN ('4990', '4090') ORDER BY code DESC LIMIT 1").get() ||
    db.prepare("SELECT * FROM accounts WHERE type = 'INCOME' ORDER BY code DESC LIMIT 1").get() ||
    defaultExpenseAcc;

  const allAccounts = db.prepare('SELECT id, code, name, type, subtype FROM accounts WHERE is_active = 1').all();
  let createdCategoriesCount = 0;

  const parsedTransactions = dataRows.map((row, index) => {
    const rawDate = mapping.dateCol >= 0 ? row[mapping.dateCol] : '';
    const date = normalizeDate(rawDate);
    const description = mapping.descriptionCol >= 0 ? (row[mapping.descriptionCol] || '') : '';
    let payee = mapping.payeeCol >= 0 ? (row[mapping.payeeCol] || '') : '';
    const reference = mapping.referenceCol >= 0 ? (row[mapping.referenceCol] || '') : '';
    const rawCat = mapping.categoryCol >= 0 ? String(row[mapping.categoryCol] || '').trim() : '';
    const rawAcc = mapping.accountCol !== undefined && mapping.accountCol >= 0 ? String(row[mapping.accountCol] || '').trim() : '';
    const rawType = mapping.typeCol >= 0 ? String(row[mapping.typeCol] || '').toUpperCase() : '';

    let signedAmount = 0;
    if (mapping.debitCol >= 0 && mapping.creditCol >= 0 && (row[mapping.debitCol] || row[mapping.creditCol])) {
      const deb = Math.abs(parseAmount(row[mapping.debitCol]));
      const cred = Math.abs(parseAmount(row[mapping.creditCol]));
      signedAmount = cred > 0 ? cred : -deb;
    } else if (mapping.amountCol >= 0) {
      signedAmount = parseAmount(row[mapping.amountCol]);
      if (rawType.includes('DEBIT') || rawType.includes('WITHDRAWAL') || rawType === 'DR' || rawType === 'EXPENSE') {
        signedAmount = -Math.abs(signedAmount);
      } else if (rawType.includes('CREDIT') || rawType.includes('DEPOSIT') || rawType === 'CR' || rawType === 'INCOME') {
        signedAmount = Math.abs(signedAmount);
      }
    }

    const isInflow = signedAmount > 0;
    const absAmount = round2(Math.abs(signedAmount));
    let txType = rawType === 'TRANSFER' ? 'TRANSFER' : isInflow ? 'INCOME' : 'EXPENSE';

    // Determine Payment / Primary Account (from CSV Account column if mapped, else selected bankAccountId)
    let paymentAccountId = Number(bankAccountId);
    if (rawAcc) {
      const matchedPayAcc = matchAccountByText(allAccounts, rawAcc);
      if (matchedPayAcc && ['ASSET', 'LIABILITY', 'EQUITY'].includes(matchedPayAcc.type)) {
        paymentAccountId = matchedPayAcc.id;
      }
    }

    // Check CSV Category Column FIRST (and auto-create category if it's a new category in the CSV), then Auto-Categorization Rules
    const matchedRule = matchCategorizationRule(description, payee, isInflow);
    let categoryAccountId = isInflow ? defaultIncomeAcc.id : defaultExpenseAcc.id;
    let categoryAccountName = isInflow ? `${defaultIncomeAcc.code} - ${defaultIncomeAcc.name}` : `${defaultExpenseAcc.code} - ${defaultExpenseAcc.name}`;
    let matchedRuleName = null;
    let isTaxDeductible = 0;

    if (rawCat) {
      const { account: foundAcc, created } = getOrCreateCSVCategoryAccount(allAccounts, rawCat, isInflow);
      if (foundAcc) {
        categoryAccountId = foundAcc.id;
        categoryAccountName = `${foundAcc.code} - ${foundAcc.name}`;
        matchedRuleName = created ? `CSV New Category (${foundAcc.code})` : `CSV Category (${foundAcc.code})`;
        if (created) createdCategoriesCount++;
        if (['ASSET', 'LIABILITY', 'EQUITY'].includes(foundAcc.type)) {
          txType = 'TRANSFER';
        }
      }
    }

    if (matchedRule && !matchedRuleName) {
      categoryAccountId = matchedRule.target_account_id;
      categoryAccountName = `${matchedRule.account_code} - ${matchedRule.account_name}`;
      matchedRuleName = `Rule: ${matchedRule.name}`;
      isTaxDeductible = matchedRule.is_tax_deductible;
      if (matchedRule.assign_payee && !payee) {
        payee = matchedRule.assign_payee;
      }
    }

    if (!payee && description) {
      payee = description.split(/[-*#]/)[0].trim().slice(0, 40);
    }

    const importHash = makeImportHash(date, signedAmount, description || payee, paymentAccountId);
    const existingDup = db.prepare('SELECT id, entry_number FROM journal_entries WHERE import_hash = ?').get(importHash);

    return {
      rowIndex: index + 1,
      date,
      description: description || payee || 'Statement Entry',
      payee,
      reference,
      csvCategory: rawCat,
      signedAmount: round2(signedAmount),
      absAmount,
      txType,
      paymentAccountId,
      categoryAccountId,
      categoryAccountName,
      matchedRule: matchedRuleName,
      matchedRuleName,
      isTaxDeductible,
      importHash,
      isDuplicate: Boolean(existingDup),
      duplicateEntryNumber: existingDup ? existingDup.entry_number : null,
      selected: absAmount > 0 && !existingDup
    };
  }).filter((t) => t.absAmount > 0);

  return {
    headers,
    mapping,
    totalRows: parsedTransactions.length,
    duplicateCount: parsedTransactions.filter((t) => t.isDuplicate).length,
    ruleMatchedCount: parsedTransactions.filter((t) => Boolean(t.matchedRuleName)).length,
    createdCategoriesCount,
    accounts: getAccountsWithBalances(),
    transactions: parsedTransactions
  };
}

module.exports = {
  computeNormalBalance,
  getAccountsWithBalances,
  getProfitAndLoss,
  getBalanceSheet,
  getTrialBalance,
  getCashFlowStatement,
  getTaxSummary,
  getMonthlyTrends,
  parseCSVText,
  normalizeDate,
  parseAmount,
  previewCSVImport,
  matchCategorizationRule
};
