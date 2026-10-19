const express = require('express');
const path = require('node:path');
const {
  db,
  round2,
  makeImportHash,
  createJournalEntry,
  createSimpleTransaction,
  seedCoreAccountsAndSettings,
  seedDemoData
} = require('./src/db');
const {
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
} = require('./src/accounting');

const app = express();
const PORT = process.env.PORT || 3456;

// Healthcheck endpoint for Cloud Load Balancers (Railway / Render / Fly.io)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Optional password protection when hosted in the cloud (set APP_PASSWORD env var)
app.use((req, res, next) => {
  const requiredPassword = process.env.APP_PASSWORD;
  if (!requiredPassword) return next();

  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const sepIdx = decoded.indexOf(':');
    const pass = sepIdx >= 0 ? decoded.slice(sepIdx + 1) : decoded;
    if (pass === requiredPassword) {
      return next();
    }
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="QuickBooks Personal Pro Ledger"');
  return res.status(401).send('Authentication required to access financial ledger.');
});

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Helper to fetch enriched journal entries with their lines and simple-view summary
function getEnrichedTransactions({
  accountId = null,
  startDate = null,
  endDate = null,
  search = null,
  sourceType = null,
  limit = 500
} = {}) {
  let whereClauses = ['1=1'];
  const params = [];

  if (startDate) {
    whereClauses.push('je.date >= ?');
    params.push(startDate);
  }
  if (endDate) {
    whereClauses.push('je.date <= ?');
    params.push(endDate);
  }
  if (sourceType) {
    whereClauses.push('je.source_type = ?');
    params.push(sourceType);
  }
  if (search) {
    whereClauses.push('(je.memo LIKE ? OR je.payee LIKE ? OR je.entry_number LIKE ? OR je.reference LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (accountId) {
    whereClauses.push('EXISTS (SELECT 1 FROM journal_lines jl2 WHERE jl2.journal_entry_id = je.id AND jl2.account_id = ?)');
    params.push(Number(accountId));
  }

  const entries = db.prepare(`
    SELECT je.*
    FROM journal_entries je
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY je.date DESC, je.id DESC
    LIMIT ?
  `).all(...params, Number(limit) || 500);

  if (entries.length === 0) return [];

  const linesStmt = db.prepare(`
    SELECT
      jl.*,
      a.code AS account_code,
      a.name AS account_name,
      a.type AS account_type,
      a.subtype AS account_subtype
    FROM journal_lines jl
    JOIN accounts a ON a.id = jl.account_id
    WHERE jl.journal_entry_id = ?
    ORDER BY jl.debit DESC, jl.id ASC
  `);

  return entries.map((entry) => {
    const lines = linesStmt.all(entry.id);
    const totalAmount = round2(lines.reduce((s, l) => s + l.debit, 0));

    // Derive primary bank/payment account and category account for the Hybrid Simple View
    const bankOrCardLine = lines.find((l) =>
      ['BANK', 'CREDIT_CARD', 'INVESTMENT'].includes(l.account_subtype)
    ) || lines[lines.length - 1];
    const otherLine = lines.find((l) => l.id !== (bankOrCardLine ? bankOrCardLine.id : -1)) || lines[0];

    let displayType = entry.source_type;
    let signedBankImpact = totalAmount;
    if (bankOrCardLine) {
      if (bankOrCardLine.account_type === 'ASSET') {
        signedBankImpact = round2(bankOrCardLine.debit - bankOrCardLine.credit);
      } else if (bankOrCardLine.account_type === 'LIABILITY') {
        // For credit card, credit increases balance owed (outflow/expense), debit pays it down
        signedBankImpact = round2(bankOrCardLine.debit - bankOrCardLine.credit);
      }
    }

    return {
      ...entry,
      total_amount: totalAmount,
      signed_impact: signedBankImpact,
      primary_account_id: bankOrCardLine ? bankOrCardLine.account_id : null,
      primary_account_name: bankOrCardLine ? `${bankOrCardLine.account_code} - ${bankOrCardLine.account_name}` : '',
      category_account_id: otherLine ? otherLine.account_id : null,
      category_account_name: otherLine ? `${otherLine.account_code} - ${otherLine.account_name}` : 'Split / Journal Entry',
      category_account_type: otherLine ? otherLine.account_type : '',
      reconciled_status: bankOrCardLine ? bankOrCardLine.reconciled_status : 'UNRECONCILED',
      lines
    };
  });
}

// 1. BOOTSTRAP ENDPOINT
app.get('/api/bootstrap', (req, res) => {
  try {
    const settingsRows = db.prepare('SELECT key, value FROM settings').all();
    const settings = {};
    for (const r of settingsRows) settings[r.key] = r.value;

    const currencies = db.prepare('SELECT * FROM currencies ORDER BY code ASC').all();
    const accounts = getAccountsWithBalances();

    const dateBounds = db.prepare('SELECT MIN(date) AS minDate, MAX(date) AS maxDate FROM journal_entries').get();
    const latestTxDate = dateBounds && dateBounds.maxDate ? dateBounds.maxDate : new Date().toISOString().slice(0, 10);
    const activeYear = latestTxDate.slice(0, 4);
    const activeMonth = latestTxDate.slice(0, 7);
    const today = `${activeYear}-12-31`;
    const yearStart = `${activeYear}-01-01`;
    const currentMonthStart = `${activeMonth}-01`;
    const currentMonthEnd = `${activeMonth}-31`;

    const bs = getBalanceSheet(today);
    const ytdPnl = getProfitAndLoss(yearStart, today);
    const monthPnl = getProfitAndLoss(currentMonthStart, currentMonthEnd);
    const monthlyTrends = getMonthlyTrends();
    const transactions = getEnrichedTransactions({ limit: 300 });

    // Budgets with current month actual spending
    const budgetsRaw = db.prepare(`
      SELECT
        b.*,
        a.code AS account_code,
        a.name AS account_name,
        a.type AS account_type
      FROM budgets b
      JOIN accounts a ON a.id = b.account_id
      ORDER BY a.code ASC
    `).all();

    const budgets = budgetsRaw.map((b) => {
      const mAcc = monthPnl.expenseAccounts.find((ea) => ea.id === b.account_id) ||
                   monthPnl.incomeAccounts.find((ia) => ia.id === b.account_id);
      const actual = mAcc ? mAcc.amount : 0;
      const pct = b.monthly_amount > 0 ? round2((actual / b.monthly_amount) * 100) : 0;
      return {
        ...b,
        actual_month: actual,
        remaining: round2(b.monthly_amount - actual),
        percent_used: pct
      };
    });

    const savingsGoals = db.prepare(`
      SELECT g.*, a.name AS linked_account_name, a.code AS linked_account_code
      FROM savings_goals g
      LEFT JOIN accounts a ON a.id = g.linked_account_id
      ORDER BY g.id ASC
    `).all();

    const invoicesBills = db.prepare(`
      SELECT
        ib.*,
        ca.name AS category_account_name,
        ca.code AS category_account_code
      FROM invoices_bills ib
      LEFT JOIN accounts ca ON ca.id = ib.category_account_id
      ORDER BY ib.due_date ASC, ib.id DESC
    `).all();

    const recurring = db.prepare(`
      SELECT
        rt.*,
        pa.name AS payment_account_name,
        pa.code AS payment_account_code,
        ca.name AS category_account_name,
        ca.code AS category_account_code
      FROM recurring_transactions rt
      LEFT JOIN accounts pa ON pa.id = rt.payment_account_id
      LEFT JOIN accounts ca ON ca.id = rt.category_account_id
      ORDER BY rt.next_date ASC
    `).all();

    const rules = db.prepare(`
      SELECT r.*, a.code AS account_code, a.name AS account_name
      FROM categorization_rules r
      JOIN accounts a ON a.id = r.target_account_id
      ORDER BY r.priority ASC, r.id ASC
    `).all();

    const importBatches = db.prepare(`
      SELECT ib.*, a.name AS account_name, a.code AS account_code
      FROM import_batches ib
      LEFT JOIN accounts a ON a.id = ib.account_id
      ORDER BY ib.id DESC
      LIMIT 25
    `).all();

    let backups = db.prepare(`
      SELECT id, label, account_count, entry_count, created_at
      FROM backup_snapshots
      ORDER BY id DESC
      LIMIT 15
    `).all();
    if (backups.length === 0) {
      saveSnapshotToDb('Initial Ledger Snapshot');
      backups = db.prepare(`
        SELECT id, label, account_count, entry_count, created_at
        FROM backup_snapshots
        ORDER BY id DESC
        LIMIT 15
      `).all();
    }

    const cashAccounts = accounts.filter((a) => a.type === 'ASSET' && a.subtype === 'BANK');
    const totalLiquidCash = round2(cashAccounts.reduce((s, a) => s + a.balance, 0));
    const creditCardAccounts = accounts.filter((a) => a.type === 'LIABILITY' && a.subtype === 'CREDIT_CARD');
    const totalCreditCardDebt = round2(creditCardAccounts.reduce((s, a) => s + a.balance, 0));

    res.json({
      settings,
      currencies,
      accounts,
      kpis: {
        netWorth: bs.netWorth,
        totalAssets: bs.totalAssets,
        totalLiabilities: bs.totalLiabilities,
        totalLiquidCash,
        totalCreditCardDebt,
        ytdIncome: ytdPnl.totalIncome,
        ytdExpenses: ytdPnl.totalExpenses,
        ytdNetIncome: ytdPnl.netIncome,
        ytdSavingsRate: ytdPnl.savingsRate,
        monthIncome: monthPnl.totalIncome,
        monthExpenses: monthPnl.totalExpenses,
        monthNetIncome: monthPnl.netIncome,
        isBooksBalanced: bs.isBalanced
      },
      monthlyTrends,
      monthExpenseBreakdown: monthPnl.expenseAccounts,
      ytdExpenseBreakdown: ytdPnl.expenseAccounts,
      transactions,
      budgets,
      savingsGoals,
      invoicesBills,
      recurring,
      rules,
      importBatches,
      backups
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. CREATE OR UPDATE SIMPLE TRANSACTION (HYBRID MODE)
app.post('/api/transactions/simple', (req, res) => {
  try {
    const entryId = createSimpleTransaction(req.body);
    res.json({ ok: true, entryId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/transactions/simple/:id', (req, res) => {
  try {
    const entryId = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(entryId);
    if (!existing) throw new Error('Transaction not found.');

    const newEntryId = createSimpleTransaction(req.body);
    db.prepare('DELETE FROM journal_entries WHERE id = ?').run(entryId);
    res.json({ ok: true, entryId: newEntryId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 3. CREATE OR UPDATE MULTI-LINE DOUBLE-ENTRY JOURNAL ENTRY
app.post('/api/journal-entries', (req, res) => {
  try {
    const entryId = createJournalEntry(req.body);
    res.json({ ok: true, entryId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/journal-entries/:id', (req, res) => {
  try {
    const entryId = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(entryId);
    if (!existing) throw new Error('Journal entry not found.');

    const {
      date = existing.date,
      memo = existing.memo,
      payee = existing.payee,
      reference = existing.reference,
      source_type = existing.source_type,
      currency = existing.currency || 'NZD',
      exchange_rate = existing.exchange_rate || 1.0,
      is_tax_deductible = existing.is_tax_deductible || 0,
      lines = []
    } = req.body;

    if (!Array.isArray(lines) || lines.length < 2) {
      throw new Error('A double-entry journal entry requires at least 2 lines.');
    }

    const rate = Number(exchange_rate) > 0 ? Number(exchange_rate) : 1.0;
    let totalDebit = 0;
    let totalCredit = 0;

    const normalizedLines = lines.map((l) => {
      const d = round2((Number(l.debit) || 0) * rate);
      const c = round2((Number(l.credit) || 0) * rate);
      totalDebit = round2(totalDebit + d);
      totalCredit = round2(totalCredit + c);
      return {
        account_id: Number(l.account_id),
        description: l.description || memo || '',
        debit: d,
        credit: c,
        reconciled_status: l.reconciled_status || 'UNRECONCILED'
      };
    });

    if (totalDebit <= 0 || Math.abs(totalDebit - totalCredit) > 0.01) {
      throw new Error(`Unbalanced Journal Entry: Debits ($${totalDebit.toFixed(2)}) must equal Credits ($${totalCredit.toFixed(2)}).`);
    }

    db.exec('BEGIN');
    try {
      db.prepare(`
        UPDATE journal_entries
        SET date = ?, memo = ?, payee = ?, reference = ?, source_type = ?, currency = ?, exchange_rate = ?, is_tax_deductible = ?
        WHERE id = ?
      `).run(
        date,
        memo,
        payee,
        reference,
        source_type,
        currency,
        rate,
        is_tax_deductible ? 1 : 0,
        entryId
      );

      db.prepare('DELETE FROM journal_lines WHERE journal_entry_id = ?').run(entryId);
      const lineStmt = db.prepare(`
        INSERT INTO journal_lines (journal_entry_id, account_id, description, debit, credit, reconciled_status)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const nl of normalizedLines) {
        lineStmt.run(entryId, nl.account_id, nl.description, nl.debit, nl.credit, nl.reconciled_status);
      }
      db.exec('COMMIT');
    } catch (inner) {
      db.exec('ROLLBACK');
      throw inner;
    }

    res.json({ ok: true, entryId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 4. LIST / FILTER JOURNAL ENTRIES
app.get('/api/journal-entries', (req, res) => {
  try {
    const entries = getEnrichedTransactions({
      accountId: req.query.accountId,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      search: req.query.search,
      sourceType: req.query.sourceType,
      limit: req.query.limit || 500
    });
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. QUICK RECATEGORIZE A TRANSACTION
app.put('/api/journal-entries/:id/category', (req, res) => {
  try {
    const entryId = Number(req.params.id);
    const { category_account_id, payee, memo, is_tax_deductible } = req.body;
    const lines = db.prepare(`
      SELECT jl.*, a.subtype
      FROM journal_lines jl
      JOIN accounts a ON a.id = jl.account_id
      WHERE jl.journal_entry_id = ?
    `).all(entryId);

    if (lines.length === 0) throw new Error('Journal entry not found.');

    // Find the non-bank line (or first expense/income line) to update its account_id
    const targetLine = lines.find((l) => !['BANK', 'CREDIT_CARD'].includes(l.subtype)) || lines[0];
    if (category_account_id) {
      db.prepare('UPDATE journal_lines SET account_id = ? WHERE id = ?').run(Number(category_account_id), targetLine.id);
    }
    if (payee !== undefined || memo !== undefined || is_tax_deductible !== undefined) {
      const current = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(entryId);
      db.prepare(`
        UPDATE journal_entries
        SET payee = ?, memo = ?, is_tax_deductible = ?
        WHERE id = ?
      `).run(
        payee !== undefined ? payee : current.payee,
        memo !== undefined ? memo : current.memo,
        is_tax_deductible !== undefined ? (is_tax_deductible ? 1 : 0) : current.is_tax_deductible,
        entryId
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 6. DELETE JOURNAL ENTRY
app.delete('/api/journal-entries/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    db.prepare('DELETE FROM journal_entries WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 7. CHART OF ACCOUNTS, OPENING BALANCES & GENERAL LEDGER DRILL-DOWN
app.post('/api/accounts', (req, res) => {
  try {
    const { code, name, type, subtype, currency = 'NZD', description = '', tax_category = '', opening_balance = 0, opening_date = '2026-01-01' } = req.body;
    if (!code || !name || !type) throw new Error('Account code, name, and type are required.');
    const acctCurr = String(currency || 'NZD').toUpperCase().trim() || 'NZD';

    const result = db.prepare(`
      INSERT INTO accounts (code, name, type, subtype, currency, description, tax_category, is_system)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      String(code).trim(),
      String(name).trim(),
      type,
      subtype || type,
      acctCurr,
      description,
      tax_category
    );
    const newAccId = Number(result.lastInsertRowid);

    const openBal = round2(Number(opening_balance) || 0);
    const openDateStr = String(opening_date || '2026-01-01').trim() || '2026-01-01';
    if (openBal !== 0) {
      const openEquity = db.prepare("SELECT * FROM accounts WHERE code = '3010'").get();
      if (openEquity) {
        const isDebitNormal = type === 'ASSET' || type === 'EXPENSE';
        const lines = isDebitNormal
          ? [
              { account_id: newAccId, description: 'Opening Balance', debit: Math.abs(openBal), credit: 0 },
              { account_id: openEquity.id, description: `Opening Balance for ${name}`, debit: 0, credit: Math.abs(openBal) }
            ]
          : [
              { account_id: openEquity.id, description: `Opening Balance for ${name}`, debit: Math.abs(openBal), credit: 0 },
              { account_id: newAccId, description: 'Opening Balance', debit: 0, credit: Math.abs(openBal) }
            ];
        createJournalEntry({
          date: openDateStr,
          memo: `Opening Balance for ${code} - ${name}`,
          payee: 'Opening Balance',
          source_type: 'OPENING_BALANCE',
          currency: acctCurr,
          lines
        });
      }
    }

    res.json({ ok: true, accountId: newAccId, currency: acctCurr });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/accounts/:id', (req, res) => {
  try {
    const accountId = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (!existing) throw new Error('Account not found.');

    const {
      code = existing.code,
      name = existing.name,
      type = existing.type,
      subtype = existing.subtype,
      currency = existing.currency,
      description = existing.description,
      tax_category = existing.tax_category,
      opening_balance,
      opening_date
    } = req.body;

    if (!String(code).trim() || !String(name).trim() || !type) {
      throw new Error('Account code, name, and type are required.');
    }

    const acctCurr = String(currency || existing.currency || 'NZD').toUpperCase().trim() || 'NZD';

    db.prepare(`
      UPDATE accounts
      SET code = ?, name = ?, type = ?, subtype = ?, currency = ?, description = ?, tax_category = ?
      WHERE id = ?
    `).run(
      String(code).trim(),
      String(name).trim(),
      type,
      subtype || type,
      acctCurr,
      description ?? '',
      tax_category ?? '',
      accountId
    );

    const effectiveOpenDate = String(opening_date || '').trim();
    if (effectiveOpenDate) {
      const openEntries = db.prepare(`
        SELECT DISTINCT je.id
        FROM journal_entries je
        JOIN journal_lines jl ON jl.journal_entry_id = je.id
        WHERE je.source_type = 'OPENING_BALANCE' AND jl.account_id = ?
      `).all(accountId);
      for (const oe of openEntries) {
        db.prepare('UPDATE journal_entries SET date = ? WHERE id = ?').run(effectiveOpenDate, oe.id);
      }
    }

    if (opening_balance !== undefined && opening_balance !== null && opening_balance !== '') {
      const currentAcc = getAccountsWithBalances().find((a) => a.id === accountId);
      const currentBal = currentAcc ? currentAcc.balance : 0;
      const targetBal = round2(Number(opening_balance) || 0);
      const delta = round2(targetBal - currentBal);
      if (Math.abs(delta) >= 0.01) {
        const openEquity = db.prepare("SELECT * FROM accounts WHERE code = '3010' AND id != ?").get(accountId) ||
                           db.prepare("SELECT * FROM accounts WHERE type = 'EQUITY' AND id != ? LIMIT 1").get(accountId);
        if (openEquity) {
          const isDebitNormal = type === 'ASSET' || type === 'EXPENSE';
          const increaseNormal = delta > 0;
          const debitTarget = (isDebitNormal && increaseNormal) || (!isDebitNormal && !increaseNormal);
          const absDelta = Math.abs(delta);
          const lines = debitTarget
            ? [
                { account_id: accountId, description: 'Opening Balance Adjustment', debit: absDelta, credit: 0 },
                { account_id: openEquity.id, description: `Opening Balance Adjustment for ${name}`, debit: 0, credit: absDelta }
              ]
            : [
                { account_id: openEquity.id, description: `Opening Balance Adjustment for ${name}`, debit: absDelta, credit: 0 },
                { account_id: accountId, description: 'Opening Balance Adjustment', debit: 0, credit: absDelta }
              ];
          createJournalEntry({
            date: effectiveOpenDate || (currentAcc && currentAcc.opening_date) || '2026-01-01',
            memo: `Opening Balance for ${code} - ${name}`,
            payee: 'Opening Balance',
            source_type: 'OPENING_BALANCE',
            currency: acctCurr,
            lines
          });
        }
      }
    }

    res.json({ ok: true, accountId, currency: acctCurr });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// BULK IMPORT / SET OPENING BALANCES WITH CUSTOM AS-OF DATE
app.post('/api/accounts/opening-balances-import', (req, res) => {
  try {
    const { csvText, rows, items, defaultDate, defaultOpeningDate } = req.body;
    const fallbackDate = normalizeDate(defaultDate || defaultOpeningDate) || '2026-01-01';
    let parsedRows = Array.isArray(rows) ? rows : (Array.isArray(items) ? items : []);

    if (csvText && String(csvText).trim()) {
      const parsed = parseCSVText(csvText);
      if (parsed.length < 2) throw new Error('CSV must include a header row and at least one account row.');
      const hdr = parsed[0].map((h) => String(h || '').toLowerCase().trim());
      const codeIdx = hdr.findIndex((h) => h.includes('code') || h.includes('number') || h === 'id');
      const nameIdx = hdr.findIndex((h) => h.includes('name') || h.includes('account'));
      const typeIdx = hdr.findIndex((h) => h === 'type' || h.includes('account type') || h.includes('account_type'));
      const subIdx = hdr.findIndex((h) => h.includes('sub') || h.includes('category'));
      const currIdx = hdr.findIndex((h) => h.includes('curr'));
      const balIdx = hdr.findIndex((h) => h.includes('bal') || h.includes('amount') || h.includes('opening'));
      const dateIdx = hdr.findIndex((h) => h.includes('date') || h.includes('as of') || h.includes('as_of'));
      parsedRows = parsed.slice(1).map((r) => ({
        code: codeIdx >= 0 ? r[codeIdx] : r[0],
        name: nameIdx >= 0 ? r[nameIdx] : (r[1] || ''),
        type: typeIdx >= 0 ? r[typeIdx] : 'ASSET',
        subtype: subIdx >= 0 ? r[subIdx] : '',
        currency: currIdx >= 0 && r[currIdx] ? String(r[currIdx]).toUpperCase().trim() : 'NZD',
        opening_balance: balIdx >= 0 ? parseAmount(r[balIdx]) : parseAmount(r[2]),
        opening_date: dateIdx >= 0 && r[dateIdx] ? normalizeDate(r[dateIdx]) : fallbackDate
      }));
    }

    if (!Array.isArray(parsedRows) || parsedRows.length === 0) {
      throw new Error('No opening balance rows provided.');
    }

    const openEquity = db.prepare("SELECT * FROM accounts WHERE code = '3010'").get() ||
                       db.prepare("SELECT * FROM accounts WHERE type = 'EQUITY' ORDER BY code ASC LIMIT 1").get();
    if (!openEquity) throw new Error('Opening Balance Equity account (3010) not found.');

    let updatedCount = 0;
    let createdAccountsCount = 0;

    for (const item of parsedRows) {
      const code = String(item.code || '').trim();
      const name = String(item.name || '').trim();
      if (!code && !name) continue;

      const rawAmount = typeof item.opening_balance === 'number' ? item.opening_balance : parseAmount(item.opening_balance ?? item.amount ?? 0);
      const openBal = round2(isNaN(rawAmount) ? 0 : rawAmount);
      const openDate = normalizeDate(item.opening_date || fallbackDate) || fallbackDate;
      const accType = String(item.type || 'ASSET').toUpperCase().trim();
      const accSubtype = String(item.subtype || accType).toUpperCase().trim();
      const itemCurr = String(item.currency || 'NZD').toUpperCase().trim() || 'NZD';

      let acc = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code) ||
                db.prepare('SELECT * FROM accounts WHERE LOWER(name) = LOWER(?)').get(name);

      if (!acc) {
        const finalCode = code || String(Math.floor(1000 + Math.random() * 8999));
        const finalName = name || `Account ${finalCode}`;
        const ins = db.prepare(`
          INSERT INTO accounts (code, name, type, subtype, currency, description, tax_category, is_system)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        `).run(finalCode, finalName, accType, accSubtype, itemCurr, item.description || '', item.tax_category || '');
        acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(ins.lastInsertRowid));
        createdAccountsCount++;
      }

      if (acc.id === openEquity.id) continue;

      const existingOpenEntries = db.prepare(`
        SELECT DISTINCT je.id
        FROM journal_entries je
        JOIN journal_lines jl ON jl.journal_entry_id = je.id
        WHERE je.source_type = 'OPENING_BALANCE' AND jl.account_id = ?
      `).all(acc.id);

      for (const oe of existingOpenEntries) {
        const lineCount = db.prepare('SELECT COUNT(*) AS c FROM journal_lines WHERE journal_entry_id = ?').get(oe.id).c;
        if (lineCount <= 2) {
          db.prepare('DELETE FROM journal_entries WHERE id = ?').run(oe.id);
        }
      }

      if (Math.abs(openBal) >= 0.01) {
        const isDebitNormal = acc.type === 'ASSET' || acc.type === 'EXPENSE';
        const positiveBal = openBal > 0;
        const debitTarget = (isDebitNormal && positiveBal) || (!isDebitNormal && !positiveBal);
        const absBal = Math.abs(openBal);

        const lines = debitTarget
          ? [
              { account_id: acc.id, description: 'Opening Balance', debit: absBal, credit: 0 },
              { account_id: openEquity.id, description: `Opening Balance for ${acc.name}`, debit: 0, credit: absBal }
            ]
          : [
              { account_id: openEquity.id, description: `Opening Balance for ${acc.name}`, debit: absBal, credit: 0 },
              { account_id: acc.id, description: 'Opening Balance', debit: 0, credit: absBal }
            ];

        createJournalEntry({
          date: openDate,
          memo: `Opening Balance for ${acc.code} - ${acc.name}`,
          payee: 'Opening Balance',
          source_type: 'OPENING_BALANCE',
          currency: acc.currency || 'NZD',
          lines
        });
        updatedCount++;
      }
    }

    res.json({ ok: true, updatedCount, createdAccountsCount });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/export/opening-balances-template.csv', (req, res) => {
  try {
    const accounts = getAccountsWithBalances().filter((a) => a.code !== '3010');
    const rows = [['Code', 'Account Name', 'Type', 'Subtype', 'Opening Balance', 'Opening Date', 'Tax Category', 'Description']];
    for (const a of accounts) {
      rows.push([
        a.code,
        `"${String(a.name || '').replace(/"/g, '""')}"`,
        a.type,
        a.subtype,
        a.balance.toFixed(2),
        a.opening_date || '2026-01-01',
        `"${String(a.tax_category || '').replace(/"/g, '""')}"`,
        `"${String(a.description || '').replace(/"/g, '""')}"`
      ]);
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="opening_balances_template.csv"');
    res.send(rows.map((r) => r.join(',')).join('\r\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/accounts/:id', (req, res) => {
  try {
    const accountId = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (!existing) throw new Error('Account not found.');

    const totalAccounts = db.prepare('SELECT COUNT(*) AS c FROM accounts').get().c;
    if (totalAccounts <= 1) {
      throw new Error('Cannot delete the last remaining account in the Chart of Accounts.');
    }

    const reassignId = req.query.reassignTo ? Number(req.query.reassignTo) : null;

    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('BEGIN');
    try {
      if (reassignId && reassignId !== accountId) {
        db.prepare('UPDATE journal_lines SET account_id = ? WHERE account_id = ?').run(reassignId, accountId);
        db.prepare('UPDATE categorization_rules SET target_account_id = ? WHERE target_account_id = ?').run(reassignId, accountId);
        db.prepare('UPDATE invoices_bills SET category_account_id = ? WHERE category_account_id = ?').run(reassignId, accountId);
        db.prepare('UPDATE invoices_bills SET ar_ap_account_id = ? WHERE ar_ap_account_id = ?').run(reassignId, accountId);
        db.prepare('UPDATE recurring_transactions SET payment_account_id = ? WHERE payment_account_id = ?').run(reassignId, accountId);
        db.prepare('UPDATE recurring_transactions SET category_account_id = ? WHERE category_account_id = ?').run(reassignId, accountId);
      } else {
        // Delete journal entries that contain lines referencing this account so double-entry stays balanced
        const affectedEntries = db.prepare('SELECT DISTINCT journal_entry_id FROM journal_lines WHERE account_id = ?').all(accountId);
        const delLines = db.prepare('DELETE FROM journal_lines WHERE journal_entry_id = ?');
        const delEntry = db.prepare('DELETE FROM journal_entries WHERE id = ?');
        for (const row of affectedEntries) {
          delLines.run(row.journal_entry_id);
          delEntry.run(row.journal_entry_id);
        }
        db.prepare('DELETE FROM categorization_rules WHERE target_account_id = ?').run(accountId);
        db.prepare('DELETE FROM invoices_bills WHERE category_account_id = ? OR ar_ap_account_id = ?').run(accountId, accountId);
        db.prepare('DELETE FROM recurring_transactions WHERE payment_account_id = ? OR category_account_id = ?').run(accountId, accountId);
      }

      db.prepare('DELETE FROM budgets WHERE account_id = ?').run(accountId);
      db.prepare('UPDATE savings_goals SET linked_account_id = NULL WHERE linked_account_id = ?').run(accountId);
      db.prepare('DELETE FROM reconciliations WHERE account_id = ?').run(accountId);
      db.prepare('DELETE FROM import_batches WHERE account_id = ?').run(accountId);
      db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);

      db.exec('COMMIT');
    } catch (inner) {
      db.exec('ROLLBACK');
      throw inner;
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/accounts/:id/ledger', (req, res) => {
  try {
    const accountId = Number(req.params.id);
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (!account) return res.status(404).json({ error: 'Account not found.' });

    const lines = db.prepare(`
      SELECT
        jl.*,
        je.entry_number,
        je.date,
        je.memo,
        je.payee,
        je.reference,
        je.source_type
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.account_id = ?
      ORDER BY je.date ASC, je.id ASC
    `).all(accountId);

    let runningBalance = 0;
    const ledgerRows = lines.map((l) => {
      const delta = computeNormalBalance(account.type, l.debit, l.credit);
      runningBalance = round2(runningBalance + delta);
      return {
        ...l,
        delta,
        running_balance: runningBalance
      };
    });

    res.json({
      account,
      ending_balance: runningBalance,
      rows: ledgerRows.reverse()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. BANK STATEMENT CSV UPLOAD (PREVIEW & COMMIT)
app.post('/api/import/csv-preview', (req, res) => {
  try {
    const { csvText, bankAccountId, customMapping } = req.body;
    if (!csvText || !bankAccountId) {
      throw new Error('Please select a target Bank/Credit Card account and provide a CSV file.');
    }
    const preview = previewCSVImport({
      csvText,
      bankAccountId: Number(bankAccountId),
      customMapping: customMapping || null
    });
    res.json(preview);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/import/csv-commit', (req, res) => {
  try {
    const { filename = 'bank_statement.csv', bankAccountId, rows, transactions, autoLearnRules = true } = req.body;
    const txRows = Array.isArray(rows) ? rows : (Array.isArray(transactions) ? transactions : []);
    if (!bankAccountId || txRows.length === 0) {
      throw new Error('No transactions selected for import.');
    }

    const bankAcc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(bankAccountId));
    if (!bankAcc) throw new Error('Target account not found.');

    let importedCount = 0;
    let skippedCount = 0;
    let totalInflow = 0;
    let totalOutflow = 0;
    let learnedRulesCount = 0;

    const batchRes = db.prepare(`
      INSERT INTO import_batches (filename, account_id, imported_count, skipped_count, total_inflow, total_outflow)
      VALUES (?, ?, 0, 0, 0, 0)
    `).run(filename, bankAcc.id);
    const batchId = Number(batchRes.lastInsertRowid);

    const uncatIds = new Set(
      db.prepare(`SELECT id FROM accounts WHERE code IN ('5990', '5999', '4990', '4090')`).all().map((a) => Number(a.id))
    );

    for (const r of txRows) {
      if (!r.selected || !(Number(r.absAmount) > 0)) {
        skippedCount++;
        continue;
      }
      const amt = round2(Math.abs(Number(r.absAmount)));
      const txType = r.txType === 'INCOME' ? 'INCOME' : r.txType === 'TRANSFER' ? 'TRANSFER' : 'EXPENSE';
      if (txType === 'INCOME') totalInflow = round2(totalInflow + amt);
      else totalOutflow = round2(totalOutflow + amt);

      const rowPayAccId = Number(r.paymentAccountId) || bankAcc.id;
      const catAccId = Number(r.categoryAccountId);

      createSimpleTransaction({
        tx_type: txType,
        date: r.date,
        amount: amt,
        currency: bankAcc.currency || 'USD',
        exchange_rate: 1.0,
        payment_account_id: rowPayAccId,
        category_account_id: catAccId,
        payee: r.payee || '',
        memo: r.description || '',
        reference: r.reference || '',
        is_tax_deductible: r.isTaxDeductible ? 1 : 0,
        reconciled_status: 'CLEARED',
        import_batch_id: batchId,
        import_hash: r.importHash || makeImportHash(r.date, r.signedAmount, r.description, rowPayAccId),
        source_type: 'CSV_IMPORT'
      });
      importedCount++;

      // Auto-learn categorization rule from payee if requested and not already covered
      if (autoLearnRules && catAccId && !uncatIds.has(catAccId)) {
        const keyword = String(r.payee || '').trim();
        if (keyword.length >= 3 && keyword.length <= 45 && !/^\d+$/.test(keyword)) {
          const existingRule = db.prepare(`
            SELECT id FROM categorization_rules WHERE LOWER(match_value) = LOWER(?)
          `).get(keyword);
          if (!existingRule) {
            db.prepare(`
              INSERT INTO categorization_rules
              (name, priority, match_field, match_type, match_value, transaction_type, target_account_id, assign_payee, is_tax_deductible)
              VALUES (?, 25, 'ANY', 'CONTAINS', ?, 'ANY', ?, ?, ?)
            `).run(
              `Auto: ${keyword}`,
              keyword.toUpperCase(),
              catAccId,
              keyword,
              r.isTaxDeductible ? 1 : 0
            );
            learnedRulesCount++;
          }
        }
      }
    }

    db.prepare(`
      UPDATE import_batches
      SET imported_count = ?, skipped_count = ?, total_inflow = ?, total_outflow = ?
      WHERE id = ?
    `).run(importedCount, skippedCount, totalInflow, totalOutflow, batchId);

    res.json({
      ok: true,
      batchId,
      importedCount,
      skippedCount,
      totalInflow,
      totalOutflow,
      learnedRulesCount
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 9. AUTO-CATEGORIZATION RULES
app.post('/api/rules', (req, res) => {
  try {
    const {
      name,
      priority = 10,
      match_field = 'ANY',
      match_type = 'CONTAINS',
      match_value,
      transaction_type = 'ANY',
      target_account_id,
      assign_payee = '',
      is_tax_deductible = 0
    } = req.body;
    if (!name || !match_value || !target_account_id) {
      throw new Error('Rule name, match text, and target category account are required.');
    }
    const r = db.prepare(`
      INSERT INTO categorization_rules (
        name, priority, match_field, match_type, match_value,
        transaction_type, target_account_id, assign_payee, is_tax_deductible
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name.trim(),
      Number(priority) || 10,
      match_field,
      match_type,
      match_value.trim(),
      transaction_type,
      Number(target_account_id),
      assign_payee.trim(),
      is_tax_deductible ? 1 : 0
    );
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/rules/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM categorization_rules WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/rules/apply-existing', (req, res) => {
  try {
    const uncatAcc = db.prepare("SELECT * FROM accounts WHERE code = '5999'").get();
    if (!uncatAcc) return res.json({ updatedCount: 0 });

    const uncatLines = db.prepare(`
      SELECT jl.id AS line_id, jl.debit, jl.credit, je.id AS entry_id, je.memo, je.payee
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.account_id = ?
    `).all(uncatAcc.id);

    let updatedCount = 0;
    for (const row of uncatLines) {
      const isInflow = row.credit > row.debit;
      const matched = matchCategorizationRule(row.memo, row.payee, isInflow);
      if (matched) {
        db.prepare('UPDATE journal_lines SET account_id = ? WHERE id = ?').run(matched.target_account_id, row.line_id);
        if (matched.assign_payee || matched.is_tax_deductible) {
          db.prepare(`
            UPDATE journal_entries
            SET payee = COALESCE(NULLIF(?, ''), payee),
                is_tax_deductible = CASE WHEN ? = 1 THEN 1 ELSE is_tax_deductible END
            WHERE id = ?
          `).run(matched.assign_payee || '', matched.is_tax_deductible, row.entry_id);
        }
        updatedCount++;
      }
    }
    res.json({ ok: true, updatedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 10. BANK RECONCILIATION WORKSPACE
app.get('/api/reconcile/:accountId', (req, res) => {
  try {
    const accountId = Number(req.params.accountId);
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (!account) return res.status(404).json({ error: 'Account not found.' });

    // Calculate Beginning Balance (sum of already RECONCILED lines for this account)
    const recRow = db.prepare(`
      SELECT
        COALESCE(SUM(debit), 0) AS rec_debit,
        COALESCE(SUM(credit), 0) AS rec_credit
      FROM journal_lines
      WHERE account_id = ? AND reconciled_status = 'RECONCILED'
    `).get(accountId);

    const beginningBalance = computeNormalBalance(account.type, recRow.rec_debit, recRow.rec_credit);

    // Get all UNRECONCILED and CLEARED lines for this account
    const openLines = db.prepare(`
      SELECT
        jl.*,
        je.entry_number,
        je.date,
        je.memo,
        je.payee,
        je.reference,
        je.source_type
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.account_id = ? AND jl.reconciled_status IN ('UNRECONCILED', 'CLEARED')
      ORDER BY je.date ASC, je.id ASC
    `).all(accountId).map((l) => ({
      ...l,
      signed_effect: computeNormalBalance(account.type, l.debit, l.credit)
    }));

    const history = db.prepare(`
      SELECT * FROM reconciliations
      WHERE account_id = ?
      ORDER BY id DESC
      LIMIT 15
    `).all(accountId);

    res.json({
      account,
      beginningBalance,
      openLines,
      history
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/reconcile/line/:lineId', (req, res) => {
  try {
    const lineId = Number(req.params.lineId);
    const { status } = req.body; // 'CLEARED' or 'UNRECONCILED'
    if (!['CLEARED', 'UNRECONCILED'].includes(status)) {
      throw new Error('Invalid status');
    }
    db.prepare('UPDATE journal_lines SET reconciled_status = ? WHERE id = ? AND reconciled_status != ?')
      .run(status, lineId, 'RECONCILED');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/reconcile/complete', (req, res) => {
  try {
    const { accountId, statementDate, endingBalance, lineIds = [], autoAdjust = false } = req.body;
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(accountId));
    if (!acc) throw new Error('Account not found.');

    const recRow = db.prepare(`
      SELECT COALESCE(SUM(debit), 0) AS d, COALESCE(SUM(credit), 0) AS c
      FROM journal_lines
      WHERE account_id = ? AND reconciled_status = 'RECONCILED'
    `).get(acc.id);
    const beginningBalance = computeNormalBalance(acc.type, recRow.d, recRow.c);

    let clearedDebits = 0;
    let clearedCredits = 0;

    if (lineIds.length > 0) {
      const placeholders = lineIds.map(() => '?').join(',');
      const selectedLines = db.prepare(`
        SELECT id, debit, credit FROM journal_lines
        WHERE account_id = ? AND id IN (${placeholders})
      `).all(acc.id, ...lineIds.map(Number));

      for (const l of selectedLines) {
        clearedDebits = round2(clearedDebits + l.debit);
        clearedCredits = round2(clearedCredits + l.credit);
      }
    }

    const clearedNetChange = computeNormalBalance(acc.type, clearedDebits, clearedCredits);
    const calculatedEnding = round2(beginningBalance + clearedNetChange);
    const targetEnding = round2(Number(endingBalance) || 0);
    const difference = round2(targetEnding - calculatedEnding);

    if (Math.abs(difference) >= 0.01 && !autoAdjust) {
      throw new Error(`Reconciliation difference is $${difference.toFixed(2)}. Either check/uncheck items to reach $0.00 difference, or enable Auto-Adjustment Entry.`);
    }

    let adjustmentJournalId = null;
    if (Math.abs(difference) >= 0.01 && autoAdjust) {
      const openEq = db.prepare("SELECT * FROM accounts WHERE code = '3010'").get();
      const absDiff = Math.abs(difference);
      const isPositiveIncrease = difference > 0;
      const isAsset = acc.type === 'ASSET';

      const debitAcc = (isAsset && isPositiveIncrease) || (!isAsset && !isPositiveIncrease) ? acc.id : openEq.id;
      const creditAcc = debitAcc === acc.id ? openEq.id : acc.id;

      adjustmentJournalId = createJournalEntry({
        date: statementDate || new Date().toISOString().slice(0, 10),
        memo: `Bank Reconciliation Balance Adjustment (${acc.name})`,
        payee: 'Reconciliation Adjustment',
        source_type: 'RECONCILIATION_ADJ',
        lines: [
          { account_id: debitAcc, description: 'Reconciliation Adjustment', debit: absDiff, credit: 0, reconciled_status: 'RECONCILED' },
          { account_id: creditAcc, description: 'Reconciliation Adjustment', debit: 0, credit: absDiff, reconciled_status: 'RECONCILED' }
        ]
      });
    }

    const recRes = db.prepare(`
      INSERT INTO reconciliations (
        account_id, statement_date, beginning_balance, ending_balance,
        cleared_debits, cleared_credits, adjustment_journal_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      acc.id,
      statementDate || new Date().toISOString().slice(0, 10),
      beginningBalance,
      targetEnding,
      clearedDebits,
      clearedCredits,
      adjustmentJournalId
    );
    const reconciliationId = Number(recRes.lastInsertRowid);

    if (lineIds.length > 0) {
      const upd = db.prepare(`
        UPDATE journal_lines
        SET reconciled_status = 'RECONCILED', reconciliation_id = ?
        WHERE id = ? AND account_id = ?
      `);
      for (const lid of lineIds) {
        upd.run(reconciliationId, Number(lid), acc.id);
      }
    }

    res.json({ ok: true, reconciliationId, adjustmentJournalId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 11. FINANCIAL REPORTS SUITE
app.get('/api/reports/all', (req, res) => {
  try {
    const startDate = req.query.startDate || '2026-01-01';
    const endDate = req.query.endDate || '2026-12-31';
    const asOfDate = req.query.asOfDate || endDate;

    const pnl = getProfitAndLoss(startDate, endDate);
    const balanceSheet = getBalanceSheet(asOfDate);
    const trialBalance = getTrialBalance(asOfDate);
    const cashFlow = getCashFlowStatement(startDate, endDate);
    const taxSummary = getTaxSummary(startDate, endDate);

    res.json({
      pnl,
      balanceSheet,
      trialBalance,
      cashFlow,
      taxSummary
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 12. BUDGETS & SAVINGS GOALS
app.post('/api/budgets', (req, res) => {
  try {
    const { account_id, monthly_amount, notes = '' } = req.body;
    if (!account_id) throw new Error('Account is required.');
    db.prepare(`
      INSERT INTO budgets (account_id, monthly_amount, notes)
      VALUES (?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        monthly_amount = excluded.monthly_amount,
        notes = excluded.notes
    `).run(Number(account_id), round2(monthly_amount), notes);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/budgets/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM budgets WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/savings-goals', (req, res) => {
  try {
    const { name, target_amount, current_amount = 0, linked_account_id = null, target_date = '', color = '#10b981', notes = '' } = req.body;
    if (!name || !target_amount) throw new Error('Goal name and target amount are required.');
    db.prepare(`
      INSERT INTO savings_goals (name, target_amount, current_amount, linked_account_id, target_date, color, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(name.trim(), round2(target_amount), round2(current_amount), linked_account_id ? Number(linked_account_id) : null, target_date, color, notes);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/savings-goals/:id', (req, res) => {
  try {
    const { current_amount, target_amount, name } = req.body;
    const goal = db.prepare('SELECT * FROM savings_goals WHERE id = ?').get(Number(req.params.id));
    if (!goal) throw new Error('Goal not found');
    db.prepare(`
      UPDATE savings_goals
      SET current_amount = ?, target_amount = ?, name = ?
      WHERE id = ?
    `).run(
      current_amount !== undefined ? round2(current_amount) : goal.current_amount,
      target_amount !== undefined ? round2(target_amount) : goal.target_amount,
      name || goal.name,
      goal.id
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/savings-goals/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM savings_goals WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 13. INVOICES (AR), BILLS (AP) & RECURRING TRANSACTIONS
app.post('/api/invoices-bills', (req, res) => {
  try {
    const {
      doc_type, // 'INVOICE' or 'BILL'
      doc_number,
      contact_name,
      contact_email = '',
      issue_date,
      due_date,
      total_amount,
      category_account_id,
      notes = ''
    } = req.body;

    const amt = round2(total_amount);
    if (!contact_name || amt <= 0 || !category_account_id) {
      throw new Error('Contact name, positive amount, and category account are required.');
    }

    const arAcc = db.prepare("SELECT * FROM accounts WHERE code = '1200'").get();
    const apAcc = db.prepare("SELECT * FROM accounts WHERE code = '2100'").get();
    const arApAccountId = doc_type === 'INVOICE' ? arAcc.id : apAcc.id;

    // Post accrual journal entry
    const lines = doc_type === 'INVOICE'
      ? [
          { account_id: arAcc.id, description: `Invoice ${doc_number} - ${contact_name}`, debit: amt, credit: 0 },
          { account_id: Number(category_account_id), description: `Invoice ${doc_number} Revenue`, debit: 0, credit: amt }
        ]
      : [
          { account_id: Number(category_account_id), description: `Bill ${doc_number} - ${contact_name}`, debit: amt, credit: 0 },
          { account_id: apAcc.id, description: `Accounts Payable - ${doc_number}`, debit: 0, credit: amt }
        ];

    const accrualEntryId = createJournalEntry({
      date: issue_date,
      memo: `${doc_type === 'INVOICE' ? 'Invoice' : 'Bill'} ${doc_number} - ${contact_name}`,
      payee: contact_name,
      reference: doc_number,
      source_type: doc_type,
      lines
    });

    db.prepare(`
      INSERT INTO invoices_bills (
        doc_type, doc_number, contact_name, contact_email, issue_date, due_date,
        status, total_amount, category_account_id, ar_ap_account_id, accrual_journal_entry_id, notes
      ) VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?)
    `).run(
      doc_type,
      doc_number,
      contact_name,
      contact_email,
      issue_date,
      due_date,
      amt,
      Number(category_account_id),
      arApAccountId,
      accrualEntryId,
      notes
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/invoices-bills/:id/pay', (req, res) => {
  try {
    const id = Number(req.params.id);
    const { payment_account_id, paid_date } = req.body;
    const doc = db.prepare('SELECT * FROM invoices_bills WHERE id = ?').get(id);
    if (!doc) throw new Error('Document not found.');
    if (doc.status === 'PAID') throw new Error('Already marked as paid.');

    const payAcc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(payment_account_id));
    if (!payAcc) throw new Error('Payment bank account is required.');

    const pDate = paid_date || new Date().toISOString().slice(0, 10);
    const amt = round2(doc.total_amount);

    const lines = doc.doc_type === 'INVOICE'
      ? [
          { account_id: payAcc.id, description: `Payment received for ${doc.doc_number}`, debit: amt, credit: 0 },
          { account_id: doc.ar_ap_account_id, description: `Clear AR for ${doc.doc_number}`, debit: 0, credit: amt }
        ]
      : [
          { account_id: doc.ar_ap_account_id, description: `Clear AP for ${doc.doc_number}`, debit: amt, credit: 0 },
          { account_id: payAcc.id, description: `Bill payment for ${doc.doc_number}`, debit: 0, credit: amt }
        ];

    const payEntryId = createJournalEntry({
      date: pDate,
      memo: `${doc.doc_type === 'INVOICE' ? 'Invoice Payment Received' : 'Bill Payment Sent'} (${doc.doc_number} - ${doc.contact_name})`,
      payee: doc.contact_name,
      reference: doc.doc_number,
      source_type: doc.doc_type,
      lines
    });

    db.prepare(`
      UPDATE invoices_bills
      SET status = 'PAID', payment_account_id = ?, paid_date = ?, payment_journal_entry_id = ?
      WHERE id = ?
    `).run(payAcc.id, pDate, payEntryId, id);

    res.json({ ok: true, paymentJournalEntryId: payEntryId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/invoices-bills/:id', (req, res) => {
  try {
    const doc = db.prepare('SELECT * FROM invoices_bills WHERE id = ?').get(Number(req.params.id));
    if (doc) {
      if (doc.accrual_journal_entry_id) {
        db.prepare('DELETE FROM journal_entries WHERE id = ?').run(doc.accrual_journal_entry_id);
      }
      if (doc.payment_journal_entry_id) {
        db.prepare('DELETE FROM journal_entries WHERE id = ?').run(doc.payment_journal_entry_id);
      }
      db.prepare('DELETE FROM invoices_bills WHERE id = ?').run(doc.id);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Recurring transactions
app.post('/api/recurring', (req, res) => {
  try {
    const {
      name, tx_type, frequency, next_date, amount,
      payment_account_id, category_account_id, payee = '', memo = '', is_tax_deductible = 0
    } = req.body;
    if (!name || !amount || !payment_account_id || !category_account_id) {
      throw new Error('Name, amount, payment account, and category account are required.');
    }
    db.prepare(`
      INSERT INTO recurring_transactions (
        name, tx_type, frequency, next_date, amount,
        payment_account_id, category_account_id, payee, memo, is_tax_deductible
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name, tx_type, frequency, next_date, round2(amount),
      Number(payment_account_id), Number(category_account_id), payee, memo, is_tax_deductible ? 1 : 0
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/recurring/:id/run', (req, res) => {
  try {
    const rec = db.prepare('SELECT * FROM recurring_transactions WHERE id = ?').get(Number(req.params.id));
    if (!rec) throw new Error('Recurring template not found.');

    const entryId = createSimpleTransaction({
      tx_type: rec.tx_type,
      date: rec.next_date,
      amount: rec.amount,
      currency: rec.currency,
      payment_account_id: rec.payment_account_id,
      category_account_id: rec.category_account_id,
      payee: rec.payee || rec.name,
      memo: rec.memo || `Scheduled: ${rec.name}`,
      is_tax_deductible: rec.is_tax_deductible
    });

    // Advance next_date
    const d = new Date(rec.next_date + 'T00:00:00Z');
    if (rec.frequency === 'WEEKLY') d.setUTCDate(d.getUTCDate() + 7);
    else if (rec.frequency === 'BIWEEKLY') d.setUTCDate(d.getUTCDate() + 14);
    else if (rec.frequency === 'MONTHLY') d.setUTCMonth(d.getUTCMonth() + 1);
    else if (rec.frequency === 'QUARTERLY') d.setUTCMonth(d.getUTCMonth() + 3);
    else if (rec.frequency === 'YEARLY') d.setUTCFullYear(d.getUTCFullYear() + 1);

    const nextDateStr = d.toISOString().slice(0, 10);
    db.prepare('UPDATE recurring_transactions SET last_run_date = ?, next_date = ? WHERE id = ?')
      .run(rec.next_date, nextDateStr, rec.id);

    res.json({ ok: true, entryId, next_date: nextDateStr });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/recurring/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM recurring_transactions WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 14. DOWNLOAD & EXPORT ENDPOINTS (CSV, SAMPLE BANK STATEMENT, JSON FULL BACKUP)
function escapeCSV(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

app.get('/api/export/sample-bank-csv', (req, res) => {
  const sampleRows = [
    ['Date', 'Description', 'Payee', 'Category', 'Reference', 'Withdrawal', 'Deposit', 'Amount'],
    ['2026-10-19', 'WHOLE FOODS MARKET #1042 ORGANIC GROCERIES', 'Whole Foods Market', 'Groceries & Supermarkets', 'POS-9921', '142.85', '', '-142.85'],
    ['2026-10-19', 'UBER *TRIP AIRPORT SHUTTLE', 'Uber', 'Auto & Transport', 'POS-9922', '48.50', '', '-48.50'],
    ['2026-10-20', 'STARBUCKS STORE #4412 ESPRESSO', 'Starbucks', 'Restaurants & Dining Out', 'POS-9925', '14.75', '', '-14.75'],
    ['2026-10-21', 'AWS CLOUD SERVICES MONTHLY HOSTING', 'Amazon Web Services', 'Software, Subscriptions & Tech', 'INV-AWS10', '64.20', '', '-64.20'],
    ['2026-10-22', 'SHELL SERVICE STATION FUEL', 'Shell Station', 'Auto & Transport', 'POS-9930', '52.10', '', '-52.10'],
    ['2026-10-24', 'PAYROLL DIRECT DEPOSIT TECHCORP INC', 'TechCorp Direct Deposit', 'Salary & Wages (Net Paycheck)', 'DD-1024', '', '4650.00', '4650.00'],
    ['2026-10-25', 'TRADER JOES #210 GROCERY', 'Trader Joes', 'Groceries & Supermarkets', 'POS-9941', '118.40', '', '-118.40']
  ];
  const csv = sampleRows.map((r) => r.map(escapeCSV).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="sample_bank_statement_oct2026.csv"');
  res.send(csv);
});

app.get('/api/export/transactions.csv', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT
        je.entry_number,
        je.date,
        je.source_type,
        je.payee,
        je.memo,
        je.reference,
        je.currency,
        je.exchange_rate,
        je.is_tax_deductible,
        a.code AS account_code,
        a.name AS account_name,
        a.type AS account_type,
        jl.description AS line_description,
        jl.debit,
        jl.credit,
        jl.reconciled_status
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      JOIN accounts a ON a.id = jl.account_id
      ORDER BY je.date DESC, je.id DESC, jl.debit DESC
    `).all();

    const header = [
      'Entry Number', 'Date', 'Type', 'Payee', 'Memo', 'Reference',
      'Account Code', 'Account Name', 'Account Type', 'Line Description',
      'Debit', 'Credit', 'Currency', 'Exchange Rate', 'Tax Deductible', 'Reconciled Status'
    ];
    const csvLines = [header.join(',')];
    for (const r of rows) {
      csvLines.push([
        r.entry_number,
        r.date,
        r.source_type,
        r.payee,
        r.memo,
        r.reference,
        r.account_code,
        r.account_name,
        r.account_type,
        r.line_description,
        r.debit.toFixed(2),
        r.credit.toFixed(2),
        r.currency,
        r.exchange_rate,
        r.is_tax_deductible ? 'Yes' : 'No',
        r.reconciled_status
      ].map(escapeCSV).join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="general_ledger_transactions.csv"');
    res.send(csvLines.join('\r\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/export/report.csv', (req, res) => {
  try {
    const type = req.query.type || 'pnl';
    const startDate = req.query.startDate || '2026-01-01';
    const endDate = req.query.endDate || '2026-12-31';
    const asOfDate = req.query.asOfDate || endDate;

    let csvRows = [];
    let filename = `${type}_report.csv`;

    if (type === 'pnl') {
      const pnl = getProfitAndLoss(startDate, endDate);
      csvRows.push(['Profit & Loss Statement (Income Statement)', `${startDate} to ${endDate}`, '']);
      csvRows.push(['Account Code', 'Account Name', 'Category', 'Amount']);
      csvRows.push(['--- REVENUE / INCOME ---', '', '', '']);
      for (const i of pnl.incomeAccounts) {
        csvRows.push([i.code, i.name, 'INCOME', i.amount.toFixed(2)]);
      }
      csvRows.push(['', 'Total Income', '', pnl.totalIncome.toFixed(2)]);
      csvRows.push(['--- OPERATING EXPENSES ---', '', '', '']);
      for (const e of pnl.expenseAccounts) {
        csvRows.push([e.code, e.name, 'EXPENSE', e.amount.toFixed(2)]);
      }
      csvRows.push(['', 'Total Expenses', '', pnl.totalExpenses.toFixed(2)]);
      csvRows.push(['', 'NET INCOME (PROFIT / SAVINGS)', '', pnl.netIncome.toFixed(2)]);
      csvRows.push(['', 'Savings / Profit Margin (%)', '', `${pnl.savingsRate}%`]);
      filename = `profit_and_loss_${startDate}_to_${endDate}.csv`;
    } else if (type === 'balance-sheet') {
      const bs = getBalanceSheet(asOfDate);
      csvRows.push(['Balance Sheet', `As of ${asOfDate}`, '']);
      csvRows.push(['Account Code', 'Account Name', 'Section', 'Balance']);
      for (const a of bs.assets) csvRows.push([a.code, a.name, 'ASSET', a.balance.toFixed(2)]);
      csvRows.push(['', 'TOTAL ASSETS', '', bs.totalAssets.toFixed(2)]);
      for (const l of bs.liabilities) csvRows.push([l.code, l.name, 'LIABILITY', l.balance.toFixed(2)]);
      csvRows.push(['', 'TOTAL LIABILITIES', '', bs.totalLiabilities.toFixed(2)]);
      for (const eq of bs.equityAccounts) csvRows.push([eq.code, eq.name, 'EQUITY', eq.balance.toFixed(2)]);
      csvRows.push(['', 'TOTAL EQUITY (NET WORTH)', '', bs.totalEquity.toFixed(2)]);
      csvRows.push(['', 'TOTAL LIABILITIES & EQUITY', '', bs.totalLiabilitiesAndEquity.toFixed(2)]);
      filename = `balance_sheet_as_of_${asOfDate}.csv`;
    } else if (type === 'trial-balance') {
      const tb = getTrialBalance(asOfDate);
      csvRows.push(['Trial Balance', `As of ${asOfDate}`, '', '']);
      csvRows.push(['Account Code', 'Account Name', 'Account Type', 'Debit Balance', 'Credit Balance']);
      for (const r of tb.rows) {
        csvRows.push([r.code, r.name, r.type, r.debit_balance.toFixed(2), r.credit_balance.toFixed(2)]);
      }
      csvRows.push(['', 'TOTALS', '', tb.totalDebit.toFixed(2), tb.totalCredit.toFixed(2)]);
      filename = `trial_balance_as_of_${asOfDate}.csv`;
    } else if (type === 'tax-summary') {
      const tx = getTaxSummary(startDate, endDate);
      csvRows.push(['Tax Summary Schedule', `${startDate} to ${endDate}`, '', '', '']);
      csvRows.push(['Section', 'Date / Code', 'Payee / Account', 'Tax Category', 'Amount']);
      for (const inc of tx.incomeRows) {
        csvRows.push(['Taxable Income', inc.code, inc.name, inc.tax_category, inc.amount.toFixed(2)]);
      }
      for (const ded of tx.deductibleRows) {
        csvRows.push(['Tax Deductible / Tax Paid', ded.date, `${ded.payee} (${ded.account_name})`, ded.tax_category, ded.amount.toFixed(2)]);
      }
      csvRows.push(['Summary', '', 'Total Taxable Income', '', tx.totalTaxableIncome.toFixed(2)]);
      csvRows.push(['Summary', '', 'Total Deductions', '', tx.businessAndItemizedDeductions.toFixed(2)]);
      csvRows.push(['Summary', '', 'Estimated Tax Liability', '', tx.estimatedTaxLiability.toFixed(2)]);
      csvRows.push(['Summary', '', 'Taxes Already Paid', '', tx.taxesAlreadyPaid.toFixed(2)]);
      filename = `tax_summary_${startDate}_to_${endDate}.csv`;
    }

    const csv = csvRows.map((r) => r.map(escapeCSV).join(',')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full JSON Database Backup Export, Snapshot History & One-Click Restore Latest
function buildBackupObject() {
  return {
    exported_at: new Date().toISOString(),
    version: '1.1.0',
    settings: db.prepare('SELECT * FROM settings').all(),
    currencies: db.prepare('SELECT * FROM currencies').all(),
    accounts: db.prepare('SELECT * FROM accounts').all(),
    journal_entries: db.prepare('SELECT * FROM journal_entries').all(),
    journal_lines: db.prepare('SELECT * FROM journal_lines').all(),
    categorization_rules: db.prepare('SELECT * FROM categorization_rules').all(),
    budgets: db.prepare('SELECT * FROM budgets').all(),
    savings_goals: db.prepare('SELECT * FROM savings_goals').all(),
    invoices_bills: db.prepare('SELECT * FROM invoices_bills').all(),
    recurring_transactions: db.prepare('SELECT * FROM recurring_transactions').all(),
    reconciliations: db.prepare('SELECT * FROM reconciliations').all()
  };
}

function saveSnapshotToDb(label = 'Manual Backup') {
  const backup = buildBackupObject();
  const res = db.prepare(`
    INSERT INTO backup_snapshots (label, account_count, entry_count, payload_json)
    VALUES (?, ?, ?, ?)
  `).run(
    label,
    backup.accounts.length,
    backup.journal_entries.length,
    JSON.stringify(backup)
  );
  // Keep latest 15 snapshots
  db.exec(`
    DELETE FROM backup_snapshots
    WHERE id NOT IN (SELECT id FROM backup_snapshots ORDER BY id DESC LIMIT 15);
  `);
  return {
    id: Number(res.lastInsertRowid),
    label,
    account_count: backup.accounts.length,
    entry_count: backup.journal_entries.length,
    backup
  };
}

function restoreFromBackupObject(data) {
  if (!data || !Array.isArray(data.accounts) || !Array.isArray(data.journal_entries)) {
    throw new Error('Invalid backup JSON data.');
  }

  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN');
  try {
    const tables = [
      'journal_lines', 'journal_entries', 'categorization_rules',
      'budgets', 'savings_goals', 'invoices_bills',
      'recurring_transactions', 'reconciliations', 'import_batches',
      'accounts', 'currencies', 'settings'
    ];
    for (const t of tables) {
      db.exec(`DELETE FROM ${t};`);
    }

    if (Array.isArray(data.settings)) {
      const sStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
      for (const r of data.settings) sStmt.run(r.key, r.value);
    }
    if (Array.isArray(data.currencies)) {
      const cStmt = db.prepare('INSERT INTO currencies (code, name, symbol, exchange_rate) VALUES (?, ?, ?, ?)');
      for (const r of data.currencies) cStmt.run(r.code, r.name, r.symbol, r.exchange_rate);
    }
    for (const a of data.accounts) {
      db.prepare(`
        INSERT INTO accounts (id, code, name, type, subtype, currency, description, tax_category, is_system, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(a.id, a.code, a.name, a.type, a.subtype, a.currency || 'NZD', a.description || '', a.tax_category || '', a.is_system || 0, a.is_active ?? 1);
    }
    for (const je of data.journal_entries) {
      db.prepare(`
        INSERT INTO journal_entries (id, entry_number, date, memo, payee, reference, source_type, currency, exchange_rate, is_tax_deductible, import_batch_id, import_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(je.id, je.entry_number, je.date, je.memo || '', je.payee || '', je.reference || '', je.source_type || 'JOURNAL', je.currency || 'NZD', je.exchange_rate || 1, je.is_tax_deductible || 0, je.import_batch_id || null, je.import_hash || null);
    }
    if (Array.isArray(data.journal_lines)) {
      for (const jl of data.journal_lines) {
        db.prepare(`
          INSERT INTO journal_lines (id, journal_entry_id, account_id, description, debit, credit, foreign_amount, reconciled_status, reconciliation_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(jl.id, jl.journal_entry_id, jl.account_id, jl.description || '', jl.debit || 0, jl.credit || 0, jl.foreign_amount || 0, jl.reconciled_status || 'UNRECONCILED', jl.reconciliation_id || null);
      }
    }
    if (Array.isArray(data.categorization_rules)) {
      for (const r of data.categorization_rules) {
        db.prepare(`
          INSERT INTO categorization_rules (id, name, priority, match_field, match_type, match_value, transaction_type, target_account_id, assign_payee, is_tax_deductible, is_active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(r.id, r.name, r.priority, r.match_field, r.match_type, r.match_value, r.transaction_type, r.target_account_id, r.assign_payee || '', r.is_tax_deductible || 0, r.is_active ?? 1);
      }
    }
    if (Array.isArray(data.budgets)) {
      for (const b of data.budgets) {
        db.prepare('INSERT INTO budgets (id, account_id, monthly_amount, notes) VALUES (?, ?, ?, ?)').run(b.id, b.account_id, b.monthly_amount, b.notes || '');
      }
    }
    if (Array.isArray(data.savings_goals)) {
      for (const g of data.savings_goals) {
        db.prepare('INSERT INTO savings_goals (id, name, target_amount, current_amount, linked_account_id, target_date, color, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(g.id, g.name, g.target_amount, g.current_amount, g.linked_account_id, g.target_date || '', g.color || '#10b981', g.notes || '');
      }
    }
    if (Array.isArray(data.invoices_bills)) {
      for (const ib of data.invoices_bills) {
        db.prepare(`
          INSERT INTO invoices_bills (id, doc_type, doc_number, contact_name, contact_email, issue_date, due_date, status, currency, exchange_rate, total_amount, category_account_id, ar_ap_account_id, payment_account_id, paid_date, accrual_journal_entry_id, payment_journal_entry_id, line_items_json, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(ib.id, ib.doc_type, ib.doc_number, ib.contact_name, ib.contact_email || '', ib.issue_date, ib.due_date, ib.status || 'OPEN', ib.currency || 'NZD', ib.exchange_rate || 1, ib.total_amount || 0, ib.category_account_id, ib.ar_ap_account_id, ib.payment_account_id || null, ib.paid_date || null, ib.accrual_journal_entry_id || null, ib.payment_journal_entry_id || null, ib.line_items_json || '[]', ib.notes || '');
      }
    }
    if (Array.isArray(data.recurring_transactions)) {
      for (const rt of data.recurring_transactions) {
        db.prepare(`
          INSERT INTO recurring_transactions (id, name, tx_type, frequency, next_date, amount, currency, payment_account_id, category_account_id, payee, memo, is_tax_deductible, is_active, last_run_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(rt.id, rt.name, rt.tx_type, rt.frequency, rt.next_date, rt.amount, rt.currency || 'NZD', rt.payment_account_id, rt.category_account_id, rt.payee || '', rt.memo || '', rt.is_tax_deductible || 0, rt.is_active ?? 1, rt.last_run_date || '');
      }
    }
    db.exec('COMMIT');
  } catch (innerErr) {
    db.exec('ROLLBACK');
    throw innerErr;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

// Ensure at least one initial snapshot exists on startup
try {
  const snapCount = db.prepare('SELECT COUNT(*) AS c FROM backup_snapshots').get().c;
  if (snapCount === 0) {
    saveSnapshotToDb('Initial Ledger Snapshot');
  }
} catch (_) {}

app.get('/api/export/backup.json', (req, res) => {
  try {
    const { backup } = saveSnapshotToDb(`Downloaded Backup (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ledger_full_backup_${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify(backup, null, 2));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/backups/create', (req, res) => {
  try {
    const label = (req.body && req.body.label) || `Saved Backup (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`;
    const snap = saveSnapshotToDb(label);
    res.json({ ok: true, id: snap.id, label: snap.label, account_count: snap.account_count, entry_count: snap.entry_count });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/backups/restore-latest', (req, res) => {
  try {
    const latest = db.prepare('SELECT * FROM backup_snapshots ORDER BY id DESC LIMIT 1').get();
    if (!latest) {
      throw new Error('No saved backup snapshot found to restore.');
    }
    const data = JSON.parse(latest.payload_json);
    restoreFromBackupObject(data);
    res.json({
      ok: true,
      restoredId: latest.id,
      label: latest.label,
      created_at: latest.created_at,
      account_count: latest.account_count,
      entry_count: latest.entry_count
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/backups/:id/restore', (req, res) => {
  try {
    const snap = db.prepare('SELECT * FROM backup_snapshots WHERE id = ?').get(Number(req.params.id));
    if (!snap) throw new Error('Backup snapshot not found.');
    const data = JSON.parse(snap.payload_json);
    restoreFromBackupObject(data);
    res.json({
      ok: true,
      restoredId: snap.id,
      label: snap.label,
      created_at: snap.created_at
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/backups/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM backup_snapshots WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/import/backup-restore', (req, res) => {
  try {
    const data = req.body;
    restoreFromBackupObject(data);
    saveSnapshotToDb(`Uploaded Backup File (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 15. SETTINGS, CURRENCIES & DEMO RESET
app.put('/api/settings', (req, res) => {
  try {
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(req.body)) {
      stmt.run(k, String(v));
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/currencies', (req, res) => {
  try {
    const { code, name, symbol, exchange_rate } = req.body;
    if (!code || !exchange_rate) throw new Error('Currency code and exchange rate required.');
    db.prepare(`
      INSERT INTO currencies (code, name, symbol, exchange_rate, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(code) DO UPDATE SET
        name = excluded.name,
        symbol = excluded.symbol,
        exchange_rate = excluded.exchange_rate,
        updated_at = CURRENT_TIMESTAMP
    `).run(code.toUpperCase().trim(), name || code, symbol || '$', Number(exchange_rate));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/reset-demo', (req, res) => {
  try {
    saveSnapshotToDb('Auto-Backup Before Demo Restore');
    db.exec('PRAGMA foreign_keys = OFF;');
    const tables = [
      'journal_lines', 'journal_entries', 'categorization_rules',
      'budgets', 'savings_goals', 'invoices_bills',
      'recurring_transactions', 'reconciliations', 'import_batches', 'accounts'
    ];
    for (const t of tables) db.exec(`DELETE FROM ${t};`);
    db.exec('PRAGMA foreign_keys = ON;');
    seedDemoData();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/clear-transactions', (req, res) => {
  try {
    const entryCount = db.prepare('SELECT COUNT(*) AS c FROM journal_entries').get().c;
    if (entryCount > 0) {
      saveSnapshotToDb(`Auto-Backup Before Empty Reset (${entryCount} entries)`);
    }
    db.exec('PRAGMA foreign_keys = OFF;');
    const tables = [
      'journal_lines', 'journal_entries', 'invoices_bills',
      'reconciliations', 'import_batches', 'recurring_transactions',
      'savings_goals', 'budgets'
    ];
    for (const t of tables) db.exec(`DELETE FROM ${t};`);
    db.exec('PRAGMA foreign_keys = ON;');
    seedCoreAccountsAndSettings();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`QuickBooks Personal Finance & Accounting Server running at http://localhost:${PORT}`);
});
