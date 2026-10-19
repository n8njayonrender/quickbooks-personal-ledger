const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'ledger.sqlite');
const db = new DatabaseSync(dbPath);

// Enable WAL and foreign keys
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS currencies (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      exchange_rate REAL NOT NULL DEFAULT 1.0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE')),
      subtype TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      description TEXT DEFAULT '',
      tax_category TEXT DEFAULT '',
      is_system INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_number TEXT NOT NULL,
      date TEXT NOT NULL,
      memo TEXT DEFAULT '',
      payee TEXT DEFAULT '',
      reference TEXT DEFAULT '',
      source_type TEXT NOT NULL DEFAULT 'JOURNAL',
      currency TEXT NOT NULL DEFAULT 'USD',
      exchange_rate REAL NOT NULL DEFAULT 1.0,
      is_tax_deductible INTEGER NOT NULL DEFAULT 0,
      import_batch_id INTEGER,
      import_hash TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS journal_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      journal_entry_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      description TEXT DEFAULT '',
      debit REAL NOT NULL DEFAULT 0.0,
      credit REAL NOT NULL DEFAULT 0.0,
      foreign_amount REAL DEFAULT 0.0,
      reconciled_status TEXT NOT NULL DEFAULT 'UNRECONCILED' CHECK(reconciled_status IN ('UNRECONCILED', 'CLEARED', 'RECONCILED')),
      reconciliation_id INTEGER,
      FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_journal_entries_date ON journal_entries(date);
    CREATE INDEX IF NOT EXISTS idx_journal_entries_hash ON journal_entries(import_hash);
    CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(journal_entry_id);
    CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id);

    CREATE TABLE IF NOT EXISTS categorization_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 10,
      match_field TEXT NOT NULL DEFAULT 'ANY' CHECK(match_field IN ('DESCRIPTION', 'PAYEE', 'ANY')),
      match_type TEXT NOT NULL DEFAULT 'CONTAINS' CHECK(match_type IN ('CONTAINS', 'STARTS_WITH', 'EXACT', 'REGEX')),
      match_value TEXT NOT NULL,
      transaction_type TEXT NOT NULL DEFAULT 'ANY' CHECK(transaction_type IN ('ANY', 'OUTFLOW', 'INFLOW')),
      target_account_id INTEGER NOT NULL,
      assign_payee TEXT DEFAULT '',
      is_tax_deductible INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (target_account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL UNIQUE,
      monthly_amount REAL NOT NULL DEFAULT 0.0,
      notes TEXT DEFAULT '',
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS savings_goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      target_amount REAL NOT NULL,
      current_amount REAL NOT NULL DEFAULT 0.0,
      linked_account_id INTEGER,
      target_date TEXT DEFAULT '',
      color TEXT DEFAULT '#10b981',
      notes TEXT DEFAULT '',
      FOREIGN KEY (linked_account_id) REFERENCES accounts(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS invoices_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_type TEXT NOT NULL CHECK(doc_type IN ('INVOICE', 'BILL')),
      doc_number TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      contact_email TEXT DEFAULT '',
      issue_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('DRAFT', 'OPEN', 'PAID', 'VOID')),
      currency TEXT NOT NULL DEFAULT 'USD',
      exchange_rate REAL NOT NULL DEFAULT 1.0,
      total_amount REAL NOT NULL DEFAULT 0.0,
      category_account_id INTEGER NOT NULL,
      ar_ap_account_id INTEGER NOT NULL,
      payment_account_id INTEGER,
      paid_date TEXT,
      accrual_journal_entry_id INTEGER,
      payment_journal_entry_id INTEGER,
      line_items_json TEXT DEFAULT '[]',
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS recurring_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      tx_type TEXT NOT NULL CHECK(tx_type IN ('EXPENSE', 'INCOME', 'TRANSFER')),
      frequency TEXT NOT NULL CHECK(frequency IN ('WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY')),
      next_date TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      payment_account_id INTEGER NOT NULL,
      category_account_id INTEGER NOT NULL,
      payee TEXT DEFAULT '',
      memo TEXT DEFAULT '',
      is_tax_deductible INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_run_date TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS reconciliations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      statement_date TEXT NOT NULL,
      beginning_balance REAL NOT NULL DEFAULT 0.0,
      ending_balance REAL NOT NULL DEFAULT 0.0,
      cleared_debits REAL NOT NULL DEFAULT 0.0,
      cleared_credits REAL NOT NULL DEFAULT 0.0,
      adjustment_journal_id INTEGER,
      completed_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      account_id INTEGER NOT NULL,
      imported_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      total_inflow REAL NOT NULL DEFAULT 0.0,
      total_outflow REAL NOT NULL DEFAULT 0.0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS backup_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      account_count INTEGER NOT NULL DEFAULT 0,
      entry_count INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function round2(num) {
  return Math.round((Number(num) + Number.EPSILON) * 100) / 100;
}

function makeImportHash(date, amount, description, accountId) {
  const norm = `${date}|${round2(amount).toFixed(2)}|${String(description || '').trim().toLowerCase()}|${accountId}`;
  return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 20);
}

function getNextEntryNumber() {
  const row = db.prepare('SELECT COUNT(*) as cnt, MAX(id) as maxId FROM journal_entries').get();
  const next = (row.maxId || 0) + 1;
  return `JE-${String(next).padStart(4, '0')}`;
}

/**
 * Creates a balanced double-entry journal entry.
 * Validates that sum(debits) == sum(credits) and > 0.
 */
function createJournalEntry({
  date,
  memo = '',
  payee = '',
  reference = '',
  source_type = 'JOURNAL',
  currency = 'USD',
  exchange_rate = 1.0,
  is_tax_deductible = 0,
  import_batch_id = null,
  import_hash = null,
  lines = []
}) {
  if (!date) throw new Error('Transaction date is required.');
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new Error('A journal entry requires at least 2 lines (Debits and Credits).');
  }

  let totalDebit = 0;
  let totalCredit = 0;
  const cleanedLines = lines.map((l) => {
    const debit = round2(l.debit || 0);
    const credit = round2(l.credit || 0);
    if (debit < 0 || credit < 0) {
      throw new Error('Debit and Credit amounts must be non-negative.');
    }
    if (debit > 0 && credit > 0) {
      throw new Error('A single journal line cannot have both Debit and Credit > 0.');
    }
    totalDebit = round2(totalDebit + debit);
    totalCredit = round2(totalCredit + credit);
    return {
      account_id: Number(l.account_id),
      description: l.description || memo || '',
      debit,
      credit,
      foreign_amount: round2(l.foreign_amount || (debit > 0 ? debit : credit)),
      reconciled_status: l.reconciled_status || 'UNRECONCILED'
    };
  }).filter(l => l.debit > 0 || l.credit > 0);

  if (cleanedLines.length < 2) {
    throw new Error('Entry must have non-zero debit and credit lines.');
  }

  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(`Double-entry out of balance: Total Debits ($${totalDebit.toFixed(2)}) != Total Credits ($${totalCredit.toFixed(2)}).`);
  }

  const entryNumber = getNextEntryNumber();
  const insertEntry = db.prepare(`
    INSERT INTO journal_entries (
      entry_number, date, memo, payee, reference, source_type,
      currency, exchange_rate, is_tax_deductible, import_batch_id, import_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertLine = db.prepare(`
    INSERT INTO journal_lines (
      journal_entry_id, account_id, description, debit, credit, foreign_amount, reconciled_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec('BEGIN');
  try {
    const res = insertEntry.run(
      entryNumber,
      date,
      memo,
      payee,
      reference,
      source_type,
      currency,
      Number(exchange_rate) || 1.0,
      is_tax_deductible ? 1 : 0,
      import_batch_id,
      import_hash
    );
    const entryId = Number(res.lastInsertRowid);

    for (const line of cleanedLines) {
      insertLine.run(
        entryId,
        line.account_id,
        line.description,
        line.debit,
        line.credit,
        line.foreign_amount,
        line.reconciled_status
      );
    }
    db.exec('COMMIT');
    return entryId;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Helper to create a simple transaction (Expense, Income, or Transfer)
 * and convert it automatically into a formal Double-Entry Journal Entry.
 */
function createSimpleTransaction({
  tx_type, // 'EXPENSE', 'INCOME', 'TRANSFER'
  date,
  amount, // positive number in transaction currency
  currency = 'USD',
  exchange_rate = 1.0,
  payment_account_id, // e.g., Checking (Asset) or Credit Card (Liability)
  category_account_id, // Expense, Income, or Destination Transfer Account
  payee = '',
  memo = '',
  reference = '',
  is_tax_deductible = 0,
  reconciled_status = 'UNRECONCILED',
  import_batch_id = null,
  import_hash = null,
  source_type = null
}) {
  const rawAmt = Math.abs(Number(amount) || 0);
  if (rawAmt <= 0) {
    throw new Error('Transaction amount must be greater than zero.');
  }
  const rate = Number(exchange_rate) || 1.0;
  const baseAmt = round2(rawAmt * rate);

  const payAcc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(payment_account_id));
  const catAcc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(category_account_id));
  if (!payAcc) throw new Error('Payment/Bank account not found.');
  if (!catAcc) throw new Error('Category/Target account not found.');

  let lines = [];
  const effectiveSource = source_type || tx_type;

  if (tx_type === 'EXPENSE') {
    // Spending money:
    // Debit Expense/Target account (increases expense or decreases liability)
    // Credit Payment account (decreases Asset Checking, or increases Liability Credit Card!)
    lines = [
      {
        account_id: catAcc.id,
        description: memo || payee || catAcc.name,
        debit: baseAmt,
        credit: 0,
        foreign_amount: rawAmt,
        reconciled_status: 'UNRECONCILED'
      },
      {
        account_id: payAcc.id,
        description: memo || payee || catAcc.name,
        debit: 0,
        credit: baseAmt,
        foreign_amount: rawAmt,
        reconciled_status
      }
    ];
  } else if (tx_type === 'INCOME') {
    // Receiving money:
    // Debit Payment account (increases Asset Checking, or decreases Liability Credit Card)
    // Credit Income/Source account (increases Income)
    lines = [
      {
        account_id: payAcc.id,
        description: memo || payee || catAcc.name,
        debit: baseAmt,
        credit: 0,
        foreign_amount: rawAmt,
        reconciled_status
      },
      {
        account_id: catAcc.id,
        description: memo || payee || catAcc.name,
        debit: 0,
        credit: baseAmt,
        foreign_amount: rawAmt,
        reconciled_status: 'UNRECONCILED'
      }
    ];
  } else if (tx_type === 'TRANSFER') {
    // Transfer from payment_account_id (From) to category_account_id (To):
    // Debit To Account (increases destination Asset or pays down Liability Credit Card)
    // Credit From Account (decreases source Asset)
    lines = [
      {
        account_id: catAcc.id,
        description: memo || `Transfer from ${payAcc.name}`,
        debit: baseAmt,
        credit: 0,
        foreign_amount: rawAmt,
        reconciled_status: 'UNRECONCILED'
      },
      {
        account_id: payAcc.id,
        description: memo || `Transfer to ${catAcc.name}`,
        debit: 0,
        credit: baseAmt,
        foreign_amount: rawAmt,
        reconciled_status
      }
    ];
  } else {
    throw new Error(`Unsupported transaction type: ${tx_type}`);
  }

  return createJournalEntry({
    date,
    memo,
    payee,
    reference,
    source_type: effectiveSource,
    currency,
    exchange_rate: rate,
    is_tax_deductible,
    import_batch_id,
    import_hash,
    lines
  });
}

function seedCoreAccountsAndSettings() {
  const settingsCount = db.prepare('SELECT COUNT(*) as c FROM settings').get().c;
  if (settingsCount === 0) {
    const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    insertSetting.run('organization_name', 'Personal Financial Ledger');
    insertSetting.run('base_currency', 'USD');
    insertSetting.run('fiscal_year_start', '01-01');
    insertSetting.run('tax_rate_estimate', '24');
  }

  const currCount = db.prepare('SELECT COUNT(*) as c FROM currencies').get().c;
  if (currCount === 0) {
    const insCurr = db.prepare('INSERT OR IGNORE INTO currencies (code, name, symbol, exchange_rate) VALUES (?, ?, ?, ?)');
    insCurr.run('USD', 'US Dollar', '$', 1.0);
    insCurr.run('NZD', 'New Zealand Dollar', 'NZ$', 0.61);
    insCurr.run('AUD', 'Australian Dollar', 'A$', 0.66);
    insCurr.run('EUR', 'Euro', '€', 1.09);
    insCurr.run('GBP', 'British Pound', '£', 1.29);
    insCurr.run('CAD', 'Canadian Dollar', 'CA$', 0.73);
    insCurr.run('JPY', 'Japanese Yen', '¥', 0.0067);
  }

  const accCount = db.prepare('SELECT COUNT(*) as c FROM accounts').get().c;
  if (accCount === 0) {
    const insAcc = db.prepare(`
      INSERT INTO accounts (code, name, type, subtype, currency, description, tax_category, is_system)
      VALUES (?, ?, ?, ?, 'USD', ?, ?, ?)
    `);

    // ASSETS
    insAcc.run('1010', 'Primary Checking Account', 'ASSET', 'BANK', 'Main everyday checking account', '', 1);
    insAcc.run('1020', 'High-Yield Savings Account', 'ASSET', 'BANK', 'Emergency fund & savings reserve', '', 1);
    insAcc.run('1030', 'Vanguard Index Brokerage', 'ASSET', 'INVESTMENT', 'S&P 500 & ETF investment portfolio', '', 0);
    insAcc.run('1040', 'Cash Wallet / Petty Cash', 'ASSET', 'BANK', 'Physical cash on hand', '', 0);
    insAcc.run('1200', 'Accounts Receivable', 'ASSET', 'RECEIVABLE', 'Unpaid client invoices & reimbursements owed to you', '', 1);
    insAcc.run('1500', 'Primary Residence & Vehicles', 'ASSET', 'FIXED_ASSET', 'Real estate & vehicle market value', '', 0);

    // LIABILITIES
    insAcc.run('2010', 'Chase Sapphire Visa Card', 'LIABILITY', 'CREDIT_CARD', 'Primary rewards credit card', '', 1);
    insAcc.run('2020', 'Amex Gold Card', 'LIABILITY', 'CREDIT_CARD', 'Dining & travel credit card', '', 0);
    insAcc.run('2100', 'Accounts Payable', 'LIABILITY', 'PAYABLE', 'Unpaid bills & scheduled vendor obligations', '', 1);
    insAcc.run('2510', 'Auto Loan Payable', 'LIABILITY', 'LOAN', 'Vehicle financing balance', '', 0);
    insAcc.run('2520', 'Home Mortgage Principal', 'LIABILITY', 'LOAN', 'Long-term residential mortgage liability', '', 0);

    // EQUITY
    insAcc.run('3010', 'Opening Balance Equity', 'EQUITY', 'EQUITY', 'Initial account opening balances', '', 1);
    insAcc.run('3020', 'Personal Net Worth Equity', 'EQUITY', 'EQUITY', 'Accumulated personal capital & owner contributions', '', 1);

    // INCOME
    insAcc.run('4010', 'Salary & Payroll Income', 'INCOME', 'OPERATING_INCOME', 'Primary employment net/gross paychecks', 'W-2 / Salary Income', 1);
    insAcc.run('4020', 'Freelance & Consulting Revenue', 'INCOME', 'OPERATING_INCOME', '1099 / self-employed consulting & project income', 'Schedule C Gross Receipts', 1);
    insAcc.run('4030', 'Interest & Dividend Income', 'INCOME', 'OTHER_INCOME', 'Savings interest & brokerage dividends', 'Schedule B Interest/Dividends', 0);
    insAcc.run('4090', 'Other Miscellaneous Income', 'INCOME', 'OTHER_INCOME', 'Refunds, gifts, cash back rewards', 'Other Income', 0);

    // EXPENSES
    insAcc.run('5010', 'Housing, Rent & Mortgage Interest', 'EXPENSE', 'OPERATING_EXPENSE', 'Monthly rent, HOA, or mortgage interest payments', 'Housing / Schedule A', 1);
    insAcc.run('5020', 'Groceries & Supermarkets', 'EXPENSE', 'OPERATING_EXPENSE', 'Household food & supermarket purchases', 'Personal Living', 1);
    insAcc.run('5030', 'Dining, Coffee & Restaurants', 'EXPENSE', 'OPERATING_EXPENSE', 'Restaurants, cafes, and takeout', 'Meals & Entertainment', 0);
    insAcc.run('5040', 'Utilities, Fiber Internet & Mobile', 'EXPENSE', 'OPERATING_EXPENSE', 'Electricity, water, gigabit internet, phone plan', 'Home Office / Utilities', 1);
    insAcc.run('5050', 'Transportation, Fuel & Transit', 'EXPENSE', 'OPERATING_EXPENSE', 'Gas, EV charging, rideshare, public transit, parking', 'Vehicle & Travel', 0);
    insAcc.run('5060', 'Software, Cloud & Subscriptions', 'EXPENSE', 'OPERATING_EXPENSE', 'SaaS tools, cloud hosting, streaming memberships', 'Software & Subscriptions', 0);
    insAcc.run('5070', 'Healthcare, Medical & Pharmacy', 'EXPENSE', 'OPERATING_EXPENSE', 'Doctor visits, dental, prescriptions, HSA', 'Medical & Dental (Schedule A)', 0);
    insAcc.run('5080', 'Insurance (Health, Auto, Home)', 'EXPENSE', 'OPERATING_EXPENSE', 'Monthly and annual insurance premiums', 'Insurance Premiums', 0);
    insAcc.run('5090', 'Home Office & Equipment', 'EXPENSE', 'OPERATING_EXPENSE', 'Computers, desk gear, office supplies', 'Business Office Expense', 0);
    insAcc.run('5100', 'Travel, Flights & Lodging', 'EXPENSE', 'OPERATING_EXPENSE', 'Airfare, hotels, and trip expenses', 'Travel Expense', 0);
    insAcc.run('5110', 'Entertainment, Fitness & Hobbies', 'EXPENSE', 'OPERATING_EXPENSE', 'Gym membership, concerts, books, recreation', 'Personal Living', 0);
    insAcc.run('5200', 'Income & Property Taxes Paid', 'EXPENSE', 'TAX_EXPENSE', 'Federal/state estimated tax payments & property tax', 'Taxes Paid', 1);
    insAcc.run('5999', 'Uncategorized Expense', 'EXPENSE', 'OPERATING_EXPENSE', 'Transactions awaiting categorization review', 'Uncategorized', 1);
  }
}

function getAccountByCode(code) {
  return db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
}

function seedDemoData() {
  seedCoreAccountsAndSettings();

  const existingEntries = db.prepare('SELECT COUNT(*) as c FROM journal_entries').get().c;
  if (existingEntries > 0) return;

  const accChecking = getAccountByCode('1010');
  const accSavings = getAccountByCode('1020');
  const accBrokerage = getAccountByCode('1030');
  const accAR = getAccountByCode('1200');
  const accProperty = getAccountByCode('1500');
  const accVisa = getAccountByCode('2010');
  const accAP = getAccountByCode('2100');
  const accAutoLoan = getAccountByCode('2510');
  const accOpeningEq = getAccountByCode('3010');
  const accSalary = getAccountByCode('4010');
  const accFreelance = getAccountByCode('4020');
  const accInterest = getAccountByCode('4030');
  const accHousing = getAccountByCode('5010');
  const accGroceries = getAccountByCode('5020');
  const accDining = getAccountByCode('5030');
  const accUtilities = getAccountByCode('5040');
  const accTransport = getAccountByCode('5050');
  const accSoftware = getAccountByCode('5060');
  const accHealthcare = getAccountByCode('5070');
  const accInsurance = getAccountByCode('5080');
  const accOffice = getAccountByCode('5090');
  const accEntertainment = getAccountByCode('5110');
  const accTaxes = getAccountByCode('5200');

  // 1. Opening Balances Journal Entry (2026-08-01)
  createJournalEntry({
    date: '2026-08-01',
    memo: 'Initial Opening Balances across Bank, Investment, Property, and Loan accounts',
    payee: 'Opening Balance',
    reference: 'OPEN-2026',
    source_type: 'OPENING_BALANCE',
    lines: [
      { account_id: accChecking.id, description: 'Opening Checking Balance', debit: 14500.00, credit: 0, reconciled_status: 'RECONCILED' },
      { account_id: accSavings.id, description: 'Opening High-Yield Savings Balance', debit: 28000.00, credit: 0, reconciled_status: 'RECONCILED' },
      { account_id: accBrokerage.id, description: 'Opening Vanguard Brokerage Portfolio', debit: 62000.00, credit: 0, reconciled_status: 'RECONCILED' },
      { account_id: accProperty.id, description: 'Vehicle & Personal Equipment Valuation', debit: 32000.00, credit: 0, reconciled_status: 'RECONCILED' },
      { account_id: accVisa.id, description: 'Opening Chase Sapphire Balance', debit: 0, credit: 1250.00, reconciled_status: 'RECONCILED' },
      { account_id: accAutoLoan.id, description: 'Opening Auto Loan Balance', debit: 0, credit: 11800.00, reconciled_status: 'RECONCILED' },
      { account_id: accOpeningEq.id, description: 'Net Opening Balance Equity', debit: 0, credit: 123450.00, reconciled_status: 'RECONCILED' }
    ]
  });

  // 2. Seed realistic transactions across Aug, Sep, Oct 2026
  const demoTxs = [
    // August 2026 (Reconciled)
    { tx_type: 'INCOME', date: '2026-08-05', amount: 4650.00, payment_account_id: accChecking.id, category_account_id: accSalary.id, payee: 'TechCorp Direct Deposit', memo: 'Bi-weekly Payroll Direct Deposit', reference: 'DD-0805', reconciled_status: 'RECONCILED' },
    { tx_type: 'EXPENSE', date: '2026-08-06', amount: 2250.00, payment_account_id: accChecking.id, category_account_id: accHousing.id, payee: 'Skyline Property Management', memo: 'August Monthly Rent & Residence Fee', reference: 'ACH-801', reconciled_status: 'RECONCILED' },
    { tx_type: 'EXPENSE', date: '2026-08-09', amount: 214.60, payment_account_id: accVisa.id, category_account_id: accGroceries.id, payee: 'Whole Foods Market', memo: 'Weekly organic groceries & household supplies', reconciled_status: 'RECONCILED' },
    { tx_type: 'EXPENSE', date: '2026-08-12', amount: 145.00, payment_account_id: accChecking.id, category_account_id: accUtilities.id, payee: 'Pacific Gas & Fiber', memo: 'Electricity & 1Gbps Fiber Internet', is_tax_deductible: 1, reconciled_status: 'RECONCILED' },
    { tx_type: 'INCOME', date: '2026-08-19', amount: 4650.00, payment_account_id: accChecking.id, category_account_id: accSalary.id, payee: 'TechCorp Direct Deposit', memo: 'Bi-weekly Payroll Direct Deposit', reference: 'DD-0819', reconciled_status: 'RECONCILED' },
    { tx_type: 'EXPENSE', date: '2026-08-22', amount: 420.00, payment_account_id: accChecking.id, category_account_id: accAutoLoan.id, payee: 'Toyota Financial Services', memo: 'Monthly Auto Loan Principal Payment', reconciled_status: 'RECONCILED' },
    { tx_type: 'TRANSFER', date: '2026-08-25', amount: 1500.00, payment_account_id: accChecking.id, category_account_id: accSavings.id, payee: 'Internal Transfer', memo: 'Monthly Emergency Fund Savings Transfer', reconciled_status: 'RECONCILED' },
    { tx_type: 'INCOME', date: '2026-08-30', amount: 118.40, payment_account_id: accSavings.id, category_account_id: accInterest.id, payee: 'Ally High-Yield Savings', memo: 'August APY Interest Payment (4.75%)', reconciled_status: 'RECONCILED' },

    // September 2026 (Mostly Reconciled/Cleared)
    { tx_type: 'INCOME', date: '2026-09-02', amount: 4650.00, payment_account_id: accChecking.id, category_account_id: accSalary.id, payee: 'TechCorp Direct Deposit', memo: 'Bi-weekly Payroll Direct Deposit', reference: 'DD-0902', reconciled_status: 'RECONCILED' },
    { tx_type: 'EXPENSE', date: '2026-09-03', amount: 2250.00, payment_account_id: accChecking.id, category_account_id: accHousing.id, payee: 'Skyline Property Management', memo: 'September Monthly Rent & Residence Fee', reference: 'ACH-901', reconciled_status: 'RECONCILED' },
    { tx_type: 'INCOME', date: '2026-09-10', amount: 2400.00, payment_account_id: accChecking.id, category_account_id: accFreelance.id, payee: 'Apex Design Labs', memo: 'UI/UX Architecture Consulting Retainer', reference: 'INV-1001', reconciled_status: 'RECONCILED' },
    { tx_type: 'EXPENSE', date: '2026-09-11', amount: 189.30, payment_account_id: accVisa.id, category_account_id: accGroceries.id, payee: 'Trader Joes', memo: 'Groceries & produce', reconciled_status: 'RECONCILED' },
    { tx_type: 'EXPENSE', date: '2026-09-14', amount: 79.99, payment_account_id: accVisa.id, category_account_id: accSoftware.id, payee: 'GitHub & AWS Cloud', memo: 'Developer cloud hosting & AI tools subscription', is_tax_deductible: 1, reconciled_status: 'RECONCILED' },
    { tx_type: 'EXPENSE', date: '2026-09-15', amount: 950.00, payment_account_id: accChecking.id, category_account_id: accTaxes.id, payee: 'IRS EFTPS Estimated Tax', memo: 'Q3 Federal Estimated Tax Payment (1040-ES)', is_tax_deductible: 1, reconciled_status: 'RECONCILED' },
    { tx_type: 'INCOME', date: '2026-09-16', amount: 4650.00, payment_account_id: accChecking.id, category_account_id: accSalary.id, payee: 'TechCorp Direct Deposit', memo: 'Bi-weekly Payroll Direct Deposit', reference: 'DD-0916', reconciled_status: 'RECONCILED' },
    { tx_type: 'EXPENSE', date: '2026-09-19', amount: 349.00, payment_account_id: accVisa.id, category_account_id: accOffice.id, payee: 'Apple Store', memo: 'Magic Trackpad & USB-C Thunderbolt Dock for Home Office', is_tax_deductible: 1, reconciled_status: 'CLEARED' },
    { tx_type: 'TRANSFER', date: '2026-09-24', amount: 1650.00, payment_account_id: accChecking.id, category_account_id: accVisa.id, payee: 'Chase Credit Card Autopay', memo: 'Monthly Credit Card Statement Payoff', reconciled_status: 'RECONCILED' },
    { tx_type: 'TRANSFER', date: '2026-09-27', amount: 2000.00, payment_account_id: accChecking.id, category_account_id: accBrokerage.id, payee: 'Vanguard Investments', memo: 'Monthly S&P 500 Index ETF Contribution', reconciled_status: 'RECONCILED' },
    { tx_type: 'INCOME', date: '2026-09-30', amount: 312.50, payment_account_id: accBrokerage.id, category_account_id: accInterest.id, payee: 'Vanguard VOO Dividend', memo: 'Q3 S&P 500 ETF Quarterly Dividend Distribution', reconciled_status: 'RECONCILED' },

    // October 2026 (Current Month - Unreconciled / Cleared for active workflow)
    { tx_type: 'INCOME', date: '2026-10-01', amount: 4650.00, payment_account_id: accChecking.id, category_account_id: accSalary.id, payee: 'TechCorp Direct Deposit', memo: 'Bi-weekly Payroll Direct Deposit', reference: 'DD-1001', reconciled_status: 'CLEARED' },
    { tx_type: 'EXPENSE', date: '2026-10-02', amount: 2250.00, payment_account_id: accChecking.id, category_account_id: accHousing.id, payee: 'Skyline Property Management', memo: 'October Monthly Rent & Residence Fee', reference: 'ACH-1001', reconciled_status: 'CLEARED' },
    { tx_type: 'EXPENSE', date: '2026-10-04', amount: 238.45, payment_account_id: accVisa.id, category_account_id: accGroceries.id, payee: 'Whole Foods Market', memo: 'Weekly Groceries & Pantry Restock', reconciled_status: 'CLEARED' },
    { tx_type: 'EXPENSE', date: '2026-10-06', amount: 64.20, payment_account_id: accVisa.id, category_account_id: accTransport.id, payee: 'Shell Station & Uber', memo: 'Fuel refill & airport rideshare', reconciled_status: 'UNRECONCILED' },
    { tx_type: 'EXPENSE', date: '2026-10-08', amount: 148.50, payment_account_id: accChecking.id, category_account_id: accUtilities.id, payee: 'Pacific Gas & Fiber', memo: 'October Electric & Gigabit Fiber Bill', is_tax_deductible: 1, reconciled_status: 'CLEARED' },
    { tx_type: 'EXPENSE', date: '2026-10-10', amount: 92.80, payment_account_id: accVisa.id, category_account_id: accDining.id, payee: 'Blue Bottle & Bistro', memo: 'Client lunch & espresso', is_tax_deductible: 1, reconciled_status: 'UNRECONCILED' },
    { tx_type: 'EXPENSE', date: '2026-10-12', amount: 185.00, payment_account_id: accChecking.id, category_account_id: accInsurance.id, payee: 'State Farm Insurance', memo: 'Monthly Auto & Renter Insurance Premium', reconciled_status: 'CLEARED' },
    { tx_type: 'EXPENSE', date: '2026-10-14', amount: 89.00, payment_account_id: accVisa.id, category_account_id: accSoftware.id, payee: 'Adobe & OpenAI API', memo: 'Creative Cloud & Developer API Subscription', is_tax_deductible: 1, reconciled_status: 'UNRECONCILED' },
    { tx_type: 'INCOME', date: '2026-10-15', amount: 4650.00, payment_account_id: accChecking.id, category_account_id: accSalary.id, payee: 'TechCorp Direct Deposit', memo: 'Bi-weekly Payroll Direct Deposit', reference: 'DD-1015', reconciled_status: 'UNRECONCILED' },
    { tx_type: 'EXPENSE', date: '2026-10-16', amount: 125.00, payment_account_id: accVisa.id, category_account_id: accHealthcare.id, payee: 'City Dental Studio', memo: 'Routine dental checkup & cleaning copay', is_tax_deductible: 1, reconciled_status: 'UNRECONCILED' },
    { tx_type: 'EXPENSE', date: '2026-10-17', amount: 164.90, payment_account_id: accVisa.id, category_account_id: accGroceries.id, payee: 'Trader Joes', memo: 'Weekend groceries & fresh produce', reconciled_status: 'UNRECONCILED' },
    { tx_type: 'EXPENSE', date: '2026-10-18', amount: 75.00, payment_account_id: accVisa.id, category_account_id: accEntertainment.id, payee: 'Equinox Fitness Club', memo: 'Monthly fitness & wellness membership', reconciled_status: 'UNRECONCILED' }
  ];

  for (const tx of demoTxs) {
    createSimpleTransaction(tx);
  }

  // 3. Seed Auto-Categorization Rules
  const insRule = db.prepare(`
    INSERT INTO categorization_rules (name, priority, match_field, match_type, match_value, transaction_type, target_account_id, assign_payee, is_tax_deductible)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insRule.run('Supermarkets & Whole Foods', 1, 'ANY', 'CONTAINS', 'WHOLE FOODS', 'OUTFLOW', accGroceries.id, 'Whole Foods Market', 0);
  insRule.run('Trader Joes Groceries', 2, 'ANY', 'CONTAINS', 'TRADER JOE', 'OUTFLOW', accGroceries.id, 'Trader Joes', 0);
  insRule.run('Uber & Rideshare', 3, 'ANY', 'CONTAINS', 'UBER', 'OUTFLOW', accTransport.id, 'Uber Technologies', 0);
  insRule.run('Shell / Chevron Fuel', 4, 'ANY', 'CONTAINS', 'SHELL', 'OUTFLOW', accTransport.id, 'Shell Station', 0);
  insRule.run('Cloud & SaaS Subscriptions', 5, 'ANY', 'CONTAINS', 'AWS', 'OUTFLOW', accSoftware.id, 'Amazon Web Services', 1);
  insRule.run('GitHub / OpenAI Dev Tools', 6, 'ANY', 'CONTAINS', 'GITHUB', 'OUTFLOW', accSoftware.id, 'GitHub Inc.', 1);
  insRule.run('Starbucks / Coffee & Dining', 7, 'ANY', 'CONTAINS', 'STARBUCKS', 'OUTFLOW', accDining.id, 'Starbucks Coffee', 0);
  insRule.run('Payroll Direct Deposit', 8, 'ANY', 'CONTAINS', 'PAYROLL', 'INFLOW', accSalary.id, 'TechCorp Direct Deposit', 0);
  insRule.run('Monthly Rent ACH', 9, 'ANY', 'CONTAINS', 'SKYLINE PROPERTY', 'OUTFLOW', accHousing.id, 'Skyline Property Management', 0);
  insRule.run('Electric & Internet Utilities', 10, 'ANY', 'CONTAINS', 'PACIFIC GAS', 'OUTFLOW', accUtilities.id, 'Pacific Gas & Fiber', 1);

  // 4. Seed Monthly Budgets
  const insBudget = db.prepare('INSERT OR IGNORE INTO budgets (account_id, monthly_amount, notes) VALUES (?, ?, ?)');
  insBudget.run(accHousing.id, 2250.00, 'Fixed monthly apartment rent');
  insBudget.run(accGroceries.id, 650.00, 'Target household grocery budget');
  insBudget.run(accDining.id, 300.00, 'Restaurants, coffee & social dining');
  insBudget.run(accUtilities.id, 180.00, 'Power, water, and gigabit fiber');
  insBudget.run(accTransport.id, 250.00, 'Gas, transit & occasional Uber');
  insBudget.run(accSoftware.id, 150.00, 'Cloud tools, AI subscriptions & streaming');
  insBudget.run(accHealthcare.id, 200.00, 'Medical, dental & pharmacy allowance');
  insBudget.run(accInsurance.id, 185.00, 'Auto and renters insurance');
  insBudget.run(accEntertainment.id, 200.00, 'Gym membership, books & events');

  // 5. Seed Savings Goals
  const insGoal = db.prepare(`
    INSERT INTO savings_goals (name, target_amount, current_amount, linked_account_id, target_date, color, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insGoal.run('6-Month Emergency Reserve', 35000.00, 29618.40, accSavings.id, '2027-03-31', '#10b981', 'High-yield liquid safety net');
  insGoal.run('House Down Payment Fund', 100000.00, 64312.50, accBrokerage.id, '2028-06-30', '#3b82f6', 'Invested in Vanguard index funds');
  insGoal.run('Japan Autumn Travel Fund', 6500.00, 4200.00, accSavings.id, '2027-10-01', '#8b5cf6', 'Flights, rail pass & ryokan stays');

  // 6. Seed Open Invoice (Accounts Receivable) & Open Bill (Accounts Payable) with proper Accrual Entries
  const invEntryId = createJournalEntry({
    date: '2026-10-10',
    memo: 'Invoice INV-1002 issued to Horizon FinTech for Q4 Architecture Audit',
    payee: 'Horizon FinTech Ltd',
    reference: 'INV-1002',
    source_type: 'INVOICE',
    lines: [
      { account_id: accAR.id, description: 'Accounts Receivable - INV-1002', debit: 3200.00, credit: 0 },
      { account_id: accFreelance.id, description: 'Consulting Revenue - INV-1002', debit: 0, credit: 3200.00 }
    ]
  });

  db.prepare(`
    INSERT INTO invoices_bills (
      doc_type, doc_number, contact_name, contact_email, issue_date, due_date,
      status, currency, exchange_rate, total_amount, category_account_id, ar_ap_account_id,
      accrual_journal_entry_id, line_items_json, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'INVOICE', 'INV-1002', 'Horizon FinTech Ltd', 'ap@horizonfintech.io', '2026-10-10', '2026-10-30',
    'OPEN', 'USD', 1.0, 3200.00, accFreelance.id, accAR.id,
    invEntryId,
    JSON.stringify([
      { description: 'Financial Ledger System Architecture Review (20 hrs @ $160/hr)', quantity: 20, rate: 160, amount: 3200 }
    ]),
    'Net 20 terms via ACH wire transfer'
  );

  const billEntryId = createJournalEntry({
    date: '2026-10-14',
    memo: 'Bill BILL-204 from Summit Tax Advisors LLP for Tax Planning Review',
    payee: 'Summit Tax Advisors LLP',
    reference: 'BILL-204',
    source_type: 'BILL',
    is_tax_deductible: 1,
    lines: [
      { account_id: accOffice.id, description: 'CPA & Tax Advisory Fee - BILL-204', debit: 450.00, credit: 0 },
      { account_id: accAP.id, description: 'Accounts Payable - BILL-204', debit: 0, credit: 450.00 }
    ]
  });

  db.prepare(`
    INSERT INTO invoices_bills (
      doc_type, doc_number, contact_name, contact_email, issue_date, due_date,
      status, currency, exchange_rate, total_amount, category_account_id, ar_ap_account_id,
      accrual_journal_entry_id, line_items_json, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'BILL', 'BILL-204', 'Summit Tax Advisors LLP', 'billing@summittaxcpa.com', '2026-10-14', '2026-10-28',
    'OPEN', 'USD', 1.0, 450.00, accOffice.id, accAP.id,
    billEntryId,
    JSON.stringify([
      { description: 'Annual Personal & Freelance Tax Optimization Session', quantity: 1, rate: 450, amount: 450 }
    ]),
    'Tax-deductible professional accounting services'
  );

  // 7. Seed Recurring Transactions
  const insRec = db.prepare(`
    INSERT INTO recurring_transactions (
      name, tx_type, frequency, next_date, amount, currency,
      payment_account_id, category_account_id, payee, memo, is_tax_deductible, last_run_date
    ) VALUES (?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?)
  `);
  insRec.run('Bi-Weekly TechCorp Paycheck', 'INCOME', 'BIWEEKLY', '2026-10-29', 4650.00, accChecking.id, accSalary.id, 'TechCorp Direct Deposit', 'Bi-weekly Payroll Direct Deposit', 0, '2026-10-15');
  insRec.run('Monthly Apartment Rent', 'EXPENSE', 'MONTHLY', '2026-11-01', 2250.00, accChecking.id, accHousing.id, 'Skyline Property Management', 'Monthly Rent & Residence Fee', 0, '2026-10-02');
  insRec.run('Electric & Gigabit Fiber Internet', 'EXPENSE', 'MONTHLY', '2026-11-08', 148.50, accChecking.id, accUtilities.id, 'Pacific Gas & Fiber', 'Monthly Electric & Fiber Bill', 1, '2026-10-08');
  insRec.run('Monthly Emergency Savings Transfer', 'TRANSFER', 'MONTHLY', '2026-10-25', 1500.00, accChecking.id, accSavings.id, 'Internal Transfer', 'Monthly High-Yield Savings Transfer', 0, '2026-08-25');
}

initSchema();
seedDemoData();

module.exports = {
  db,
  round2,
  makeImportHash,
  getNextEntryNumber,
  createJournalEntry,
  createSimpleTransaction,
  seedCoreAccountsAndSettings,
  seedDemoData
};
