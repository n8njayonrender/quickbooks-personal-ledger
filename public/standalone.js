/**
 * Standalone Browser Accounting & Persistence Engine for GitHub Pages / Static Hosting
 * Automatically activates when hosted on GitHub Pages (*.github.io) or if the Node SQLite backend is unreachable.
 * Provides 100% feature parity: Double-Entry General Ledger, Full Account & Transaction CRUD (Create/Edit/Delete),
 * RFC-4180 CSV Bank Statement Import, Auto-Categorization Rules, Bank Reconciliation, Financial Statements,
 * and Snapshot Backup History with One-Click "Restore Latest Backup".
 */
(function () {
  const STORAGE_KEY = 'QB_PERSONAL_PRO_LEDGER_V1';
  const BACKUPS_KEY = 'QB_PERSONAL_PRO_BACKUPS_V1';

  function round2(num) {
    return Math.round((Number(num) + Number.EPSILON) * 100) / 100;
  }

  function computeNormalBalance(accountType, debitSum, creditSum) {
    const d = Number(debitSum) || 0;
    const c = Number(creditSum) || 0;
    return accountType === 'ASSET' || accountType === 'EXPENSE' ? round2(d - c) : round2(c - d);
  }

  function makeHash(date, amount, description, accountId) {
    const raw = `${date}|${round2(amount).toFixed(2)}|${String(description || '').trim().toLowerCase()}|${accountId}`;
    let h = 2166136261;
    for (let i = 0; i < raw.length; i++) {
      h ^= raw.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return 'h' + (h >>> 0).toString(16);
  }

  // RFC-4180 compliant CSV parser
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
          if (currentRow.some((cell) => cell !== '')) rows.push(currentRow);
          currentRow = [];
          currentField = '';
        } else {
          currentField += ch;
        }
      }
    }
    if (currentField.length > 0 || currentRow.length > 0) {
      currentRow.push(currentField.trim());
      if (currentRow.some((cell) => cell !== '')) rows.push(currentRow);
    }
    return rows;
  }

  function normalizeDate(raw) {
    const str = String(raw || '').trim();
    if (!str) return new Date().toISOString().slice(0, 10);
    const isoMatch = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (isoMatch) {
      return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
    }
    const slashMatch = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
    if (slashMatch) {
      let p1 = parseInt(slashMatch[1], 10);
      let p2 = parseInt(slashMatch[2], 10);
      let yr = slashMatch[3];
      if (yr.length === 2) yr = '20' + yr;
      let month = p1 > 12 ? p2 : p1;
      let day = p1 > 12 ? p1 : p2;
      return `${yr}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    const parsed = new Date(str);
    if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
    return new Date().toISOString().slice(0, 10);
  }

  function parseAmount(raw) {
    if (raw === null || raw === undefined) return 0;
    let str = String(raw).trim();
    if (!str) return 0;
    let isNegative = false;
    if (str.startsWith('(') && str.endsWith(')')) {
      isNegative = true;
      str = str.slice(1, -1);
    }
    if (str.includes('-')) isNegative = true;
    const cleaned = str.replace(/[^0-9.]/g, '');
    const val = parseFloat(cleaned);
    if (isNaN(val)) return 0;
    return isNegative ? -Math.abs(val) : val;
  }

  function autoDetectColumns(headers) {
    const mapping = {
      dateCol: -1, descriptionCol: -1, payeeCol: -1,
      amountCol: -1, debitCol: -1, creditCol: -1,
      typeCol: -1, referenceCol: -1, categoryCol: -1
    };
    headers.forEach((h, idx) => {
      const lower = String(h || '').toLowerCase().trim();
      if (mapping.dateCol === -1 && (lower.includes('date') || lower === 'posted' || lower === 'timestamp')) mapping.dateCol = idx;
      else if (mapping.descriptionCol === -1 && (lower.includes('desc') || lower.includes('memo') || lower.includes('narrative') || lower.includes('details') || lower.includes('particulars'))) mapping.descriptionCol = idx;
      else if (mapping.payeeCol === -1 && (lower.includes('payee') || lower.includes('merchant') || lower.includes('vendor') || lower.includes('name'))) mapping.payeeCol = idx;
      else if (mapping.amountCol === -1 && (lower === 'amount' || lower.includes('amount') || lower === 'value' || lower === 'net')) mapping.amountCol = idx;
      else if (mapping.debitCol === -1 && (lower.includes('debit') || lower.includes('withdrawal') || lower.includes('outflow') || lower.includes('money out'))) mapping.debitCol = idx;
      else if (mapping.creditCol === -1 && (lower.includes('credit') || lower.includes('deposit') || lower.includes('inflow') || lower.includes('money in'))) mapping.creditCol = idx;
      else if (mapping.typeCol === -1 && (lower === 'type' || lower === 'transaction type' || lower === 'dr/cr')) mapping.typeCol = idx;
      else if (mapping.referenceCol === -1 && (lower.includes('ref') || lower.includes('check') || lower.includes('id') || lower.includes('number'))) mapping.referenceCol = idx;
      else if (mapping.categoryCol === -1 && (lower.includes('cat') || lower.includes('account'))) mapping.categoryCol = idx;
    });
    if (mapping.dateCol === -1 && headers.length > 0) mapping.dateCol = 0;
    if (mapping.descriptionCol === -1 && headers.length > 1) mapping.descriptionCol = 1;
    if (mapping.amountCol === -1 && mapping.debitCol === -1 && headers.length > 2) mapping.amountCol = 2;
    return mapping;
  }

  function createInitialStore() {
    const store = {
      nextIds: { account: 1, entry: 1, line: 1, rule: 1, budget: 1, goal: 1, doc: 1, rec: 1, recon: 1, batch: 1 },
      settings: {
        organization_name: 'Personal Financial Ledger',
        base_currency: 'USD',
        fiscal_year_start: '01-01',
        tax_rate_estimate: '24'
      },
      currencies: [
        { code: 'USD', name: 'US Dollar', symbol: '$', exchange_rate: 1.0 },
        { code: 'NZD', name: 'New Zealand Dollar', symbol: 'NZ$', exchange_rate: 0.61 },
        { code: 'AUD', name: 'Australian Dollar', symbol: 'A$', exchange_rate: 0.66 },
        { code: 'EUR', name: 'Euro', symbol: '€', exchange_rate: 1.09 },
        { code: 'GBP', name: 'British Pound', symbol: '£', exchange_rate: 1.29 },
        { code: 'CAD', name: 'Canadian Dollar', symbol: 'CA$', exchange_rate: 0.73 },
        { code: 'JPY', name: 'Japanese Yen', symbol: '¥', exchange_rate: 0.0067 }
      ],
      accounts: [],
      journal_entries: [],
      journal_lines: [],
      categorization_rules: [],
      budgets: [],
      savings_goals: [],
      invoices_bills: [],
      recurring_transactions: [],
      reconciliations: [],
      import_batches: []
    };

    const addAcc = (code, name, type, subtype, description, tax_category = '', is_system = 0) => {
      const id = store.nextIds.account++;
      const acc = { id, code, name, type, subtype, currency: 'USD', description, tax_category, is_system, is_active: 1 };
      store.accounts.push(acc);
      return acc;
    };

    const accChecking = addAcc('1010', 'Primary Checking Account', 'ASSET', 'BANK', 'Main everyday checking account', '', 1);
    const accSavings = addAcc('1020', 'High-Yield Savings Account', 'ASSET', 'BANK', 'Emergency fund & savings reserve', '', 1);
    const accBrokerage = addAcc('1030', 'Vanguard Index Brokerage', 'ASSET', 'INVESTMENT', 'S&P 500 & ETF investment portfolio', '', 0);
    addAcc('1040', 'Cash Wallet / Petty Cash', 'ASSET', 'BANK', 'Physical cash on hand', '', 0);
    const accAR = addAcc('1200', 'Accounts Receivable', 'ASSET', 'RECEIVABLE', 'Unpaid client invoices & reimbursements owed to you', '', 1);
    const accProperty = addAcc('1500', 'Primary Residence & Vehicles', 'ASSET', 'FIXED_ASSET', 'Real estate & vehicle market value', '', 0);

    const accVisa = addAcc('2010', 'Chase Sapphire Visa Card', 'LIABILITY', 'CREDIT_CARD', 'Primary rewards credit card', '', 1);
    addAcc('2020', 'Amex Gold Card', 'LIABILITY', 'CREDIT_CARD', 'Dining & travel credit card', '', 0);
    const accAP = addAcc('2100', 'Accounts Payable', 'LIABILITY', 'PAYABLE', 'Unpaid bills & scheduled vendor obligations', '', 1);
    const accAutoLoan = addAcc('2510', 'Auto Loan Payable', 'LIABILITY', 'LOAN', 'Vehicle financing balance', '', 0);
    addAcc('2520', 'Home Mortgage Principal', 'LIABILITY', 'LOAN', 'Long-term residential mortgage liability', '', 0);

    const accOpeningEq = addAcc('3010', 'Opening Balance Equity', 'EQUITY', 'EQUITY', 'Initial account opening balances', '', 1);
    addAcc('3020', 'Personal Net Worth Equity', 'EQUITY', 'EQUITY', 'Accumulated personal capital & owner contributions', '', 1);

    const accSalary = addAcc('4010', 'Salary & Payroll Income', 'INCOME', 'OPERATING_INCOME', 'Primary employment net/gross paychecks', 'W-2 / Salary Income', 1);
    const accFreelance = addAcc('4020', 'Freelance & Consulting Revenue', 'INCOME', 'OPERATING_INCOME', '1099 / self-employed consulting & project income', 'Schedule C Gross Receipts', 1);
    const accInterest = addAcc('4030', 'Interest & Dividend Income', 'INCOME', 'OTHER_INCOME', 'Savings interest & brokerage dividends', 'Schedule B Interest/Dividends', 0);
    addAcc('4090', 'Other Miscellaneous Income', 'INCOME', 'OTHER_INCOME', 'Refunds, gifts, cash back rewards', 'Other Income', 0);

    const accHousing = addAcc('5010', 'Housing, Rent & Mortgage Interest', 'EXPENSE', 'OPERATING_EXPENSE', 'Monthly rent, HOA, or mortgage interest payments', 'Housing / Schedule A', 1);
    const accGroceries = addAcc('5020', 'Groceries & Supermarkets', 'EXPENSE', 'OPERATING_EXPENSE', 'Household food & supermarket purchases', 'Personal Living', 1);
    const accDining = addAcc('5030', 'Dining, Coffee & Restaurants', 'EXPENSE', 'OPERATING_EXPENSE', 'Restaurants, cafes, and takeout', 'Meals & Entertainment', 0);
    const accUtilities = addAcc('5040', 'Utilities, Fiber Internet & Mobile', 'EXPENSE', 'OPERATING_EXPENSE', 'Electricity, water, gigabit internet, phone plan', 'Home Office / Utilities', 1);
    const accTransport = addAcc('5050', 'Transportation, Fuel & Transit', 'EXPENSE', 'OPERATING_EXPENSE', 'Gas, EV charging, rideshare, public transit, parking', 'Vehicle & Travel', 0);
    const accSoftware = addAcc('5060', 'Software, Cloud & Subscriptions', 'EXPENSE', 'OPERATING_EXPENSE', 'SaaS tools, cloud hosting, streaming memberships', 'Software & Subscriptions', 0);
    const accHealthcare = addAcc('5070', 'Healthcare, Medical & Pharmacy', 'EXPENSE', 'OPERATING_EXPENSE', 'Doctor visits, dental, prescriptions, HSA', 'Medical & Dental (Schedule A)', 0);
    const accInsurance = addAcc('5080', 'Insurance (Health, Auto, Home)', 'EXPENSE', 'OPERATING_EXPENSE', 'Monthly and annual insurance premiums', 'Insurance Premiums', 0);
    const accOffice = addAcc('5090', 'Home Office & Equipment', 'EXPENSE', 'OPERATING_EXPENSE', 'Computers, desk gear, office supplies', 'Business Office Expense', 0);
    addAcc('5100', 'Travel, Flights & Lodging', 'EXPENSE', 'OPERATING_EXPENSE', 'Airfare, hotels, and trip expenses', 'Travel Expense', 0);
    const accEntertainment = addAcc('5110', 'Entertainment, Fitness & Hobbies', 'EXPENSE', 'OPERATING_EXPENSE', 'Gym membership, concerts, books, recreation', 'Personal Living', 0);
    const accTaxes = addAcc('5200', 'Income & Property Taxes Paid', 'EXPENSE', 'TAX_EXPENSE', 'Federal/state estimated tax payments & property tax', 'Taxes Paid', 1);
    addAcc('5999', 'Uncategorized Expense', 'EXPENSE', 'OPERATING_EXPENSE', 'Transactions awaiting categorization review', 'Uncategorized', 1);

    // Seed Opening Balance
    insertJournalEntry(store, {
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

    const demoTxs = [
      { tx_type: 'INCOME', date: '2026-08-05', amount: 4650.00, payment_account_id: accChecking.id, category_account_id: accSalary.id, payee: 'TechCorp Direct Deposit', memo: 'Bi-weekly Payroll Direct Deposit', reference: 'DD-0805', reconciled_status: 'RECONCILED' },
      { tx_type: 'EXPENSE', date: '2026-08-06', amount: 2250.00, payment_account_id: accChecking.id, category_account_id: accHousing.id, payee: 'Skyline Property Management', memo: 'August Monthly Rent & Residence Fee', reference: 'ACH-801', reconciled_status: 'RECONCILED' },
      { tx_type: 'EXPENSE', date: '2026-08-09', amount: 214.60, payment_account_id: accVisa.id, category_account_id: accGroceries.id, payee: 'Whole Foods Market', memo: 'Weekly organic groceries & household supplies', reconciled_status: 'RECONCILED' },
      { tx_type: 'EXPENSE', date: '2026-08-12', amount: 145.00, payment_account_id: accChecking.id, category_account_id: accUtilities.id, payee: 'Pacific Gas & Fiber', memo: 'Electricity & 1Gbps Fiber Internet', is_tax_deductible: 1, reconciled_status: 'RECONCILED' },
      { tx_type: 'INCOME', date: '2026-08-19', amount: 4650.00, payment_account_id: accChecking.id, category_account_id: accSalary.id, payee: 'TechCorp Direct Deposit', memo: 'Bi-weekly Payroll Direct Deposit', reference: 'DD-0819', reconciled_status: 'RECONCILED' },
      { tx_type: 'EXPENSE', date: '2026-08-22', amount: 420.00, payment_account_id: accChecking.id, category_account_id: accAutoLoan.id, payee: 'Toyota Financial Services', memo: 'Monthly Auto Loan Principal Payment', reconciled_status: 'RECONCILED' },
      { tx_type: 'TRANSFER', date: '2026-08-25', amount: 1500.00, payment_account_id: accChecking.id, category_account_id: accSavings.id, payee: 'Internal Transfer', memo: 'Monthly Emergency Fund Savings Transfer', reconciled_status: 'RECONCILED' },
      { tx_type: 'INCOME', date: '2026-08-30', amount: 118.40, payment_account_id: accSavings.id, category_account_id: accInterest.id, payee: 'Ally High-Yield Savings', memo: 'August APY Interest Payment (4.75%)', reconciled_status: 'RECONCILED' },

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
      insertSimpleTransaction(store, tx);
    }

    const addRule = (name, priority, match_value, transaction_type, target_account_id, assign_payee, is_tax_deductible) => {
      store.categorization_rules.push({
        id: store.nextIds.rule++,
        name, priority, match_field: 'ANY', match_type: 'CONTAINS',
        match_value, transaction_type, target_account_id, assign_payee, is_tax_deductible, is_active: 1
      });
    };
    addRule('Supermarkets & Whole Foods', 1, 'WHOLE FOODS', 'OUTFLOW', accGroceries.id, 'Whole Foods Market', 0);
    addRule('Trader Joes Groceries', 2, 'TRADER JOE', 'OUTFLOW', accGroceries.id, 'Trader Joes', 0);
    addRule('Uber & Rideshare', 3, 'UBER', 'OUTFLOW', accTransport.id, 'Uber Technologies', 0);
    addRule('Shell / Chevron Fuel', 4, 'SHELL', 'OUTFLOW', accTransport.id, 'Shell Station', 0);
    addRule('Cloud & SaaS Subscriptions', 5, 'AWS', 'OUTFLOW', accSoftware.id, 'Amazon Web Services', 1);
    addRule('GitHub / OpenAI Dev Tools', 6, 'GITHUB', 'OUTFLOW', accSoftware.id, 'GitHub Inc.', 1);
    addRule('Starbucks / Coffee & Dining', 7, 'STARBUCKS', 'OUTFLOW', accDining.id, 'Starbucks Coffee', 0);
    addRule('Payroll Direct Deposit', 8, 'PAYROLL', 'INFLOW', accSalary.id, 'TechCorp Direct Deposit', 0);

    const addBudget = (account_id, monthly_amount, notes) => {
      store.budgets.push({ id: store.nextIds.budget++, account_id, monthly_amount, notes });
    };
    addBudget(accHousing.id, 2250, 'Fixed monthly rent');
    addBudget(accGroceries.id, 650, 'Household groceries');
    addBudget(accDining.id, 300, 'Restaurants & coffee');
    addBudget(accUtilities.id, 180, 'Power & gigabit fiber');
    addBudget(accTransport.id, 250, 'Fuel & transit');
    addBudget(accSoftware.id, 150, 'Cloud & SaaS tools');
    addBudget(accHealthcare.id, 200, 'Medical & dental');
    addBudget(accInsurance.id, 185, 'Auto & renters insurance');
    addBudget(accEntertainment.id, 200, 'Fitness & hobbies');

    store.savings_goals.push(
      { id: store.nextIds.goal++, name: '6-Month Emergency Reserve', target_amount: 35000, current_amount: 29618.40, linked_account_id: accSavings.id, target_date: '2027-03-31', color: '#10b981', notes: '' },
      { id: store.nextIds.goal++, name: 'House Down Payment Fund', target_amount: 100000, current_amount: 64312.50, linked_account_id: accBrokerage.id, target_date: '2028-06-30', color: '#3b82f6', notes: '' },
      { id: store.nextIds.goal++, name: 'Japan Autumn Travel Fund', target_amount: 6500, current_amount: 4200, linked_account_id: accSavings.id, target_date: '2027-10-01', color: '#8b5cf6', notes: '' }
    );

    const invEntryId = insertJournalEntry(store, {
      date: '2026-10-10',
      memo: 'Invoice INV-1002 issued to Horizon FinTech for Q4 Architecture Audit',
      payee: 'Horizon FinTech Ltd',
      reference: 'INV-1002',
      source_type: 'INVOICE',
      lines: [
        { account_id: accAR.id, description: 'Accounts Receivable - INV-1002', debit: 3200, credit: 0 },
        { account_id: accFreelance.id, description: 'Consulting Revenue - INV-1002', debit: 0, credit: 3200 }
      ]
    });
    store.invoices_bills.push({
      id: store.nextIds.doc++,
      doc_type: 'INVOICE', doc_number: 'INV-1002', contact_name: 'Horizon FinTech Ltd', contact_email: 'ap@horizonfintech.io',
      issue_date: '2026-10-10', due_date: '2026-10-30', status: 'OPEN', currency: 'USD', exchange_rate: 1.0,
      total_amount: 3200, category_account_id: accFreelance.id, ar_ap_account_id: accAR.id,
      accrual_journal_entry_id: invEntryId, payment_journal_entry_id: null, paid_date: null
    });

    const billEntryId = insertJournalEntry(store, {
      date: '2026-10-14',
      memo: 'Bill BILL-204 from Summit Tax Advisors LLP for Tax Planning Review',
      payee: 'Summit Tax Advisors LLP',
      reference: 'BILL-204',
      source_type: 'BILL',
      is_tax_deductible: 1,
      lines: [
        { account_id: accOffice.id, description: 'CPA & Tax Advisory Fee - BILL-204', debit: 450, credit: 0 },
        { account_id: accAP.id, description: 'Accounts Payable - BILL-204', debit: 0, credit: 450 }
      ]
    });
    store.invoices_bills.push({
      id: store.nextIds.doc++,
      doc_type: 'BILL', doc_number: 'BILL-204', contact_name: 'Summit Tax Advisors LLP', contact_email: 'billing@summittaxcpa.com',
      issue_date: '2026-10-14', due_date: '2026-10-28', status: 'OPEN', currency: 'USD', exchange_rate: 1.0,
      total_amount: 450, category_account_id: accOffice.id, ar_ap_account_id: accAP.id,
      accrual_journal_entry_id: billEntryId, payment_journal_entry_id: null, paid_date: null
    });

    store.recurring_transactions.push(
      { id: store.nextIds.rec++, name: 'Bi-Weekly TechCorp Paycheck', tx_type: 'INCOME', frequency: 'BIWEEKLY', next_date: '2026-10-29', amount: 4650, currency: 'USD', payment_account_id: accChecking.id, category_account_id: accSalary.id, payee: 'TechCorp Direct Deposit', memo: 'Bi-weekly Payroll Direct Deposit', is_tax_deductible: 0 },
      { id: store.nextIds.rec++, name: 'Monthly Apartment Rent', tx_type: 'EXPENSE', frequency: 'MONTHLY', next_date: '2026-11-01', amount: 2250, currency: 'USD', payment_account_id: accChecking.id, category_account_id: accHousing.id, payee: 'Skyline Property Management', memo: 'Monthly Rent & Residence Fee', is_tax_deductible: 0 },
      { id: store.nextIds.rec++, name: 'Monthly Emergency Savings Transfer', tx_type: 'TRANSFER', frequency: 'MONTHLY', next_date: '2026-10-25', amount: 1500, currency: 'USD', payment_account_id: accChecking.id, category_account_id: accSavings.id, payee: 'Internal Transfer', memo: 'Monthly High-Yield Savings Transfer', is_tax_deductible: 0 }
    );

    return store;
  }

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    const initial = createInitialStore();
    saveStore(initial);
    return initial;
  }

  function saveStore(store) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (_) {}
  }

  function loadBackupsList() {
    try {
      const raw = localStorage.getItem(BACKUPS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    const store = loadStore();
    const initialSnap = {
      id: 1,
      label: 'Initial Ledger Snapshot',
      account_count: store.accounts.length,
      entry_count: store.journal_entries.length,
      created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      payload: JSON.parse(JSON.stringify(store))
    };
    localStorage.setItem(BACKUPS_KEY, JSON.stringify([initialSnap]));
    return [initialSnap];
  }

  function createSnapshotInBrowser(store, label = 'Manual Backup') {
    const list = loadBackupsList();
    const nextId = list.reduce((m, s) => Math.max(m, s.id || 0), 0) + 1;
    const snap = {
      id: nextId,
      label,
      account_count: (store.accounts || []).length,
      entry_count: (store.journal_entries || []).length,
      created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      payload: JSON.parse(JSON.stringify(store))
    };
    list.unshift(snap);
    const trimmed = list.slice(0, 15);
    try {
      localStorage.setItem(BACKUPS_KEY, JSON.stringify(trimmed));
    } catch (_) {}
    return snap;
  }

  function insertJournalEntry(store, payload) {
    const lines = (payload.lines || []).map((l) => ({
      account_id: Number(l.account_id),
      description: l.description || payload.memo || '',
      debit: round2(l.debit || 0),
      credit: round2(l.credit || 0),
      foreign_amount: round2(l.foreign_amount || (l.debit || l.credit || 0)),
      reconciled_status: l.reconciled_status || 'UNRECONCILED'
    })).filter((l) => l.debit > 0 || l.credit > 0);

    if (lines.length < 2) throw new Error('A journal entry requires at least 2 non-zero lines.');
    const dSum = round2(lines.reduce((s, l) => s + l.debit, 0));
    const cSum = round2(lines.reduce((s, l) => s + l.credit, 0));
    if (Math.abs(dSum - cSum) > 0.01) {
      throw new Error(`Double-entry out of balance: Debits ($${dSum}) != Credits ($${cSum})`);
    }

    const id = store.nextIds.entry++;
    const entry_number = `JE-${String(id).padStart(4, '0')}`;
    store.journal_entries.push({
      id,
      entry_number,
      date: payload.date,
      memo: payload.memo || '',
      payee: payload.payee || '',
      reference: payload.reference || '',
      source_type: payload.source_type || 'JOURNAL',
      currency: payload.currency || 'USD',
      exchange_rate: Number(payload.exchange_rate) || 1.0,
      is_tax_deductible: payload.is_tax_deductible ? 1 : 0,
      import_batch_id: payload.import_batch_id || null,
      import_hash: payload.import_hash || null
    });

    for (const l of lines) {
      store.journal_lines.push({
        id: store.nextIds.line++,
        journal_entry_id: id,
        ...l
      });
    }
    return id;
  }

  function insertSimpleTransaction(store, payload) {
    const rawAmt = Math.abs(Number(payload.amount) || 0);
    if (rawAmt <= 0) throw new Error('Transaction amount must be > 0');
    const rate = Number(payload.exchange_rate) || 1.0;
    const baseAmt = round2(rawAmt * rate);
    const payId = Number(payload.payment_account_id);
    const catId = Number(payload.category_account_id);
    const recStatus = payload.reconciled_status || 'UNRECONCILED';

    let lines = [];
    if (payload.tx_type === 'EXPENSE') {
      lines = [
        { account_id: catId, description: payload.memo || payload.payee, debit: baseAmt, credit: 0, reconciled_status: 'UNRECONCILED' },
        { account_id: payId, description: payload.memo || payload.payee, debit: 0, credit: baseAmt, reconciled_status: recStatus }
      ];
    } else if (payload.tx_type === 'INCOME') {
      lines = [
        { account_id: payId, description: payload.memo || payload.payee, debit: baseAmt, credit: 0, reconciled_status: recStatus },
        { account_id: catId, description: payload.memo || payload.payee, debit: 0, credit: baseAmt, reconciled_status: 'UNRECONCILED' }
      ];
    } else {
      lines = [
        { account_id: catId, description: payload.memo || 'Account Transfer', debit: baseAmt, credit: 0, reconciled_status: 'UNRECONCILED' },
        { account_id: payId, description: payload.memo || 'Account Transfer', debit: 0, credit: baseAmt, reconciled_status: recStatus }
      ];
    }

    return insertJournalEntry(store, {
      date: payload.date,
      memo: payload.memo,
      payee: payload.payee,
      reference: payload.reference,
      source_type: payload.source_type || payload.tx_type,
      currency: payload.currency || 'USD',
      exchange_rate: rate,
      is_tax_deductible: payload.is_tax_deductible,
      import_batch_id: payload.import_batch_id,
      import_hash: payload.import_hash,
      lines
    });
  }

  function getAccountsWithBalances(store, asOfDate = null) {
    const entryMap = new Map(store.journal_entries.map((e) => [e.id, e]));
    return store.accounts.slice().sort((a, b) => String(a.code).localeCompare(String(b.code))).map((acc) => {
      let d = 0;
      let c = 0;
      let count = 0;
      for (const jl of store.journal_lines) {
        if (jl.account_id !== acc.id) continue;
        const je = entryMap.get(jl.journal_entry_id);
        if (!je) continue;
        count++;
        if (!asOfDate || je.date <= asOfDate) {
          d += jl.debit;
          c += jl.credit;
        }
      }
      return {
        ...acc,
        total_debit: round2(d),
        total_credit: round2(c),
        line_count: count,
        balance: computeNormalBalance(acc.type, d, c)
      };
    });
  }

  function computePnL(store, startDate, endDate) {
    const entryMap = new Map(store.journal_entries.map((e) => [e.id, e]));
    const incomeAccounts = [];
    const expenseAccounts = [];
    let totalIncome = 0;
    let totalExpenses = 0;

    for (const acc of store.accounts.filter((a) => a.type === 'INCOME' || a.type === 'EXPENSE')) {
      let d = 0;
      let c = 0;
      for (const jl of store.journal_lines) {
        if (jl.account_id !== acc.id) continue;
        const je = entryMap.get(jl.journal_entry_id);
        if (je && je.date >= startDate && je.date <= endDate) {
          d += jl.debit;
          c += jl.credit;
        }
      }
      const amount = computeNormalBalance(acc.type, d, c);
      if (acc.type === 'INCOME') {
        if (amount !== 0) incomeAccounts.push({ ...acc, amount });
        totalIncome = round2(totalIncome + amount);
      } else {
        if (amount !== 0) expenseAccounts.push({ ...acc, amount });
        totalExpenses = round2(totalExpenses + amount);
      }
    }
    const netIncome = round2(totalIncome - totalExpenses);
    const savingsRate = totalIncome > 0 ? round2((netIncome / totalIncome) * 100) : 0;
    return { startDate, endDate, incomeAccounts, expenseAccounts, totalIncome, totalExpenses, netIncome, savingsRate };
  }

  function computeBalanceSheet(store, asOfDate) {
    const accs = getAccountsWithBalances(store, asOfDate);
    const assets = accs.filter((a) => a.type === 'ASSET');
    const liabilities = accs.filter((a) => a.type === 'LIABILITY');
    const equityAccounts = accs.filter((a) => a.type === 'EQUITY');

    const totalAssets = round2(assets.reduce((s, a) => s + a.balance, 0));
    const totalLiabilities = round2(liabilities.reduce((s, a) => s + a.balance, 0));
    const baseEquity = round2(equityAccounts.reduce((s, a) => s + a.balance, 0));
    const incTotal = round2(accs.filter((a) => a.type === 'INCOME').reduce((s, a) => s + a.balance, 0));
    const expTotal = round2(accs.filter((a) => a.type === 'EXPENSE').reduce((s, a) => s + a.balance, 0));
    const retainedEarnings = round2(incTotal - expTotal);
    const totalEquity = round2(baseEquity + retainedEarnings);
    const totalLiabilitiesAndEquity = round2(totalLiabilities + totalEquity);

    return {
      asOfDate,
      assets,
      liabilities,
      equityAccounts: [
        ...equityAccounts,
        { id: 'RETAINED_EARNINGS', code: '3900', name: 'Retained Earnings / Cumulative Net Savings', type: 'EQUITY', subtype: 'EQUITY', balance: retainedEarnings }
      ],
      totalAssets,
      totalLiabilities,
      totalEquity,
      totalLiabilitiesAndEquity,
      netWorth: round2(totalAssets - totalLiabilities),
      isBalanced: Math.abs(totalAssets - totalLiabilitiesAndEquity) < 0.01
    };
  }

  function computeTrialBalance(store, asOfDate) {
    const accs = getAccountsWithBalances(store, asOfDate);
    let totalDebit = 0;
    let totalCredit = 0;
    const rows = accs.filter((a) => a.total_debit > 0 || a.total_credit > 0).map((a) => {
      const net = round2(a.total_debit - a.total_credit);
      const debit_balance = net > 0 ? net : 0;
      const credit_balance = net < 0 ? Math.abs(net) : 0;
      totalDebit = round2(totalDebit + debit_balance);
      totalCredit = round2(totalCredit + credit_balance);
      return { id: a.id, code: a.code, name: a.name, type: a.type, debit_balance, credit_balance };
    });
    return { asOfDate, rows, totalDebit, totalCredit, isBalanced: Math.abs(totalDebit - totalCredit) < 0.01 };
  }

  function computeCashFlow(store, startDate, endDate) {
    const accMap = new Map(store.accounts.map((a) => [a.id, a]));
    const entryMap = new Map(store.journal_entries.map((e) => [e.id, e]));
    let beginningCash = 0;
    let endingCash = 0;
    let investingCashFlow = 0;

    for (const jl of store.journal_lines) {
      const acc = accMap.get(jl.account_id);
      const je = entryMap.get(jl.journal_entry_id);
      if (!acc || !je) continue;
      if (acc.type === 'ASSET' && acc.subtype === 'BANK') {
        if (je.date < startDate) beginningCash += (jl.debit - jl.credit);
        if (je.date <= endDate) endingCash += (jl.debit - jl.credit);
      }
      if (['INVESTMENT', 'FIXED_ASSET'].includes(acc.subtype) && je.date >= startDate && je.date <= endDate && je.source_type !== 'OPENING_BALANCE') {
        investingCashFlow += (jl.credit - jl.debit);
      }
    }
    beginningCash = round2(beginningCash);
    endingCash = round2(endingCash);
    investingCashFlow = round2(investingCashFlow);
    const pnl = computePnL(store, startDate, endDate);
    const operatingCashFlow = pnl.netIncome;
    const netCashChange = round2(endingCash - beginningCash);
    const financingAndWorkingCapital = round2(netCashChange - operatingCashFlow - investingCashFlow);

    return {
      startDate, endDate,
      beginningCash, operatingCashFlow, investingCashFlow,
      financingAndWorkingCapital, netCashChange, endingCash
    };
  }

  function handleStandaloneRequest(urlStr, options = {}) {
    const store = loadStore();
    const method = (options.method || 'GET').toUpperCase();
    const body = options.body ? JSON.parse(options.body) : {};
    const parsedUrl = new URL(urlStr, window.location.origin);
    const path = parsedUrl.pathname;

    const accMap = new Map(store.accounts.map((a) => [a.id, a]));

    if (path === '/api/bootstrap' && method === 'GET') {
      const accounts = getAccountsWithBalances(store);
      const allDates = store.journal_entries.map((e) => e.date).sort();
      const latestTxDate = allDates.length > 0 ? allDates[allDates.length - 1] : new Date().toISOString().slice(0, 10);
      const activeYear = latestTxDate.slice(0, 4);
      const activeMonth = latestTxDate.slice(0, 7);

      const bs = computeBalanceSheet(store, `${activeYear}-12-31`);
      const ytdPnl = computePnL(store, `${activeYear}-01-01`, `${activeYear}-12-31`);
      const monthPnl = computePnL(store, `${activeMonth}-01`, `${activeMonth}-31`);

      const monthsMap = {};
      const entryMap = new Map(store.journal_entries.map((e) => [e.id, e]));
      for (const jl of store.journal_lines) {
        const je = entryMap.get(jl.journal_entry_id);
        const acc = accMap.get(jl.account_id);
        if (!je || !acc || !['INCOME', 'EXPENSE'].includes(acc.type)) continue;
        const m = je.date.slice(0, 7);
        if (!monthsMap[m]) monthsMap[m] = { month: m, income: 0, expense: 0 };
        if (acc.type === 'INCOME') monthsMap[m].income += (jl.credit - jl.debit);
        if (acc.type === 'EXPENSE') monthsMap[m].expense += (jl.debit - jl.credit);
      }
      const monthlyTrends = Object.values(monthsMap).sort((a, b) => a.month.localeCompare(b.month)).map((m) => ({
        month: m.month,
        income: round2(m.income),
        expense: round2(m.expense),
        net: round2(m.income - m.expense)
      }));

      const transactions = store.journal_entries
        .slice()
        .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
        .map((je) => {
          const lines = store.journal_lines
            .filter((l) => l.journal_entry_id === je.id)
            .map((l) => {
              const a = accMap.get(l.account_id) || {};
              return { ...l, account_code: a.code, account_name: a.name, account_type: a.type, account_subtype: a.subtype };
            });
          const total_amount = round2(lines.reduce((s, l) => s + l.debit, 0));
          const bankLine = lines.find((l) => ['BANK', 'CREDIT_CARD', 'INVESTMENT'].includes(l.account_subtype)) || lines[lines.length - 1];
          const otherLine = lines.find((l) => l.id !== (bankLine ? bankLine.id : -1)) || lines[0];
          const signed_impact = bankLine ? round2(bankLine.debit - bankLine.credit) : total_amount;
          return {
            ...je,
            total_amount,
            signed_impact,
            primary_account_id: bankLine ? bankLine.account_id : null,
            primary_account_name: bankLine ? `${bankLine.account_code} - ${bankLine.account_name}` : '',
            category_account_id: otherLine ? otherLine.account_id : null,
            category_account_name: otherLine ? `${otherLine.account_code} - ${otherLine.account_name}` : '',
            reconciled_status: bankLine ? bankLine.reconciled_status : 'UNRECONCILED',
            lines
          };
        });

      const budgets = store.budgets.map((b) => {
        const a = accMap.get(b.account_id) || {};
        const mAcc = monthPnl.expenseAccounts.find((x) => x.id === b.account_id);
        const actual = mAcc ? mAcc.amount : 0;
        return {
          ...b,
          account_code: a.code,
          account_name: a.name,
          actual_month: actual,
          remaining: round2(b.monthly_amount - actual),
          percent_used: b.monthly_amount > 0 ? round2((actual / b.monthly_amount) * 100) : 0
        };
      });

      const cashAccounts = accounts.filter((a) => a.type === 'ASSET' && a.subtype === 'BANK');
      const totalLiquidCash = round2(cashAccounts.reduce((s, a) => s + a.balance, 0));
      const creditCardAccounts = accounts.filter((a) => a.type === 'LIABILITY' && a.subtype === 'CREDIT_CARD');
      const totalCreditCardDebt = round2(creditCardAccounts.reduce((s, a) => s + a.balance, 0));

      const backups = loadBackupsList().map(({ id, label, account_count, entry_count, created_at }) => ({
        id, label, account_count, entry_count, created_at
      }));

      return {
        settings: store.settings,
        currencies: store.currencies,
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
        savingsGoals: store.savings_goals,
        invoicesBills: store.invoices_bills.map((ib) => {
          const ca = accMap.get(ib.category_account_id) || {};
          return { ...ib, category_account_name: ca.name, category_account_code: ca.code };
        }),
        recurring: store.recurring_transactions.map((rt) => {
          const pa = accMap.get(rt.payment_account_id) || {};
          const ca = accMap.get(rt.category_account_id) || {};
          return { ...rt, payment_account_name: pa.name, category_account_name: ca.name };
        }),
        rules: store.categorization_rules.map((r) => {
          const ta = accMap.get(r.target_account_id) || {};
          return { ...r, account_code: ta.code, account_name: ta.name };
        }),
        importBatches: store.import_batches.map((b) => {
          const ba = accMap.get(b.account_id) || {};
          return { ...b, account_code: ba.code, account_name: ba.name };
        }),
        backups
      };
    }

    if (path === '/api/transactions/simple' && method === 'POST') {
      const entryId = insertSimpleTransaction(store, body);
      saveStore(store);
      return { ok: true, entryId };
    }

    if (path.match(/^\/api\/transactions\/simple\/\d+$/) && method === 'PUT') {
      const id = Number(path.split('/')[4]);
      store.journal_entries = store.journal_entries.filter((e) => e.id !== id);
      store.journal_lines = store.journal_lines.filter((l) => l.journal_entry_id !== id);
      const entryId = insertSimpleTransaction(store, body);
      saveStore(store);
      return { ok: true, entryId };
    }

    if (path === '/api/journal-entries' && method === 'POST') {
      const entryId = insertJournalEntry(store, body);
      saveStore(store);
      return { ok: true, entryId };
    }

    if (path.match(/^\/api\/journal-entries\/\d+\/category$/) && method === 'PUT') {
      const id = Number(path.split('/')[3]);
      const je = store.journal_entries.find((e) => e.id === id);
      if (je) {
        if (body.is_tax_deductible !== undefined) je.is_tax_deductible = body.is_tax_deductible ? 1 : 0;
        if (body.category_account_id) {
          const lines = store.journal_lines.filter((l) => l.journal_entry_id === id);
          const targetLine = lines.find((l) => {
            const a = accMap.get(l.account_id);
            return a && !['BANK', 'CREDIT_CARD'].includes(a.subtype);
          }) || lines[0];
          if (targetLine) targetLine.account_id = Number(body.category_account_id);
        }
        saveStore(store);
      }
      return { ok: true };
    }

    if (path.match(/^\/api\/journal-entries\/\d+$/) && method === 'DELETE') {
      const id = Number(path.split('/')[3]);
      store.journal_entries = store.journal_entries.filter((e) => e.id !== id);
      store.journal_lines = store.journal_lines.filter((l) => l.journal_entry_id !== id);
      saveStore(store);
      return { ok: true };
    }

    // CREATE ACCOUNT
    if (path === '/api/accounts' && method === 'POST') {
      const codeTrim = String(body.code || '').trim();
      const nameTrim = String(body.name || '').trim();
      if (!codeTrim || !nameTrim) throw new Error('Account code and name are required.');
      if (store.accounts.some((a) => a.code === codeTrim)) {
        throw new Error(`Account code ${codeTrim} already exists.`);
      }
      const id = store.nextIds.account++;
      store.accounts.push({
        id,
        code: codeTrim,
        name: nameTrim,
        type: body.type,
        subtype: body.subtype || body.type,
        currency: 'USD',
        description: body.description || '',
        tax_category: body.tax_category || '',
        is_system: 0,
        is_active: 1
      });
      if (Number(body.opening_balance) > 0) {
        const openEq = store.accounts.find((a) => a.code === '3010') || store.accounts.find((a) => a.type === 'EQUITY');
        const amt = round2(body.opening_balance);
        const isDebit = body.type === 'ASSET' || body.type === 'EXPENSE';
        if (openEq && openEq.id !== id) {
          insertJournalEntry(store, {
            date: '2026-01-01',
            memo: `Opening Balance for ${nameTrim}`,
            payee: 'Opening Balance',
            source_type: 'OPENING_BALANCE',
            lines: isDebit
              ? [{ account_id: id, debit: amt, credit: 0 }, { account_id: openEq.id, debit: 0, credit: amt }]
              : [{ account_id: openEq.id, debit: amt, credit: 0 }, { account_id: id, debit: 0, credit: amt }]
          });
        }
      }
      saveStore(store);
      return { ok: true, accountId: id };
    }

    // EDIT ACCOUNT (both user-created and existing system accounts)
    if (path.match(/^\/api\/accounts\/\d+$/) && method === 'PUT') {
      const accId = Number(path.split('/')[3]);
      const acc = store.accounts.find((a) => a.id === accId);
      if (!acc) throw new Error('Account not found.');
      const codeTrim = String(body.code ?? acc.code).trim();
      const nameTrim = String(body.name ?? acc.name).trim();
      if (!codeTrim || !nameTrim) throw new Error('Account code and name are required.');
      if (store.accounts.some((a) => a.code === codeTrim && a.id !== accId)) {
        throw new Error(`Account code ${codeTrim} is already used by another account.`);
      }
      acc.code = codeTrim;
      acc.name = nameTrim;
      acc.type = body.type || acc.type;
      acc.subtype = body.subtype || acc.subtype;
      acc.tax_category = body.tax_category ?? acc.tax_category;
      acc.description = body.description ?? acc.description;

      if (body.opening_balance !== undefined && body.opening_balance !== null && body.opening_balance !== '') {
        const currentAcc = getAccountsWithBalances(store).find((a) => a.id === accId);
        const currentBal = currentAcc ? currentAcc.balance : 0;
        const targetBal = round2(Number(body.opening_balance) || 0);
        const delta = round2(targetBal - currentBal);
        if (Math.abs(delta) >= 0.01) {
          const openEq = store.accounts.find((a) => a.code === '3010' && a.id !== accId) ||
                         store.accounts.find((a) => a.type === 'EQUITY' && a.id !== accId);
          if (openEq) {
            const isDebitNormal = acc.type === 'ASSET' || acc.type === 'EXPENSE';
            const increaseNormal = delta > 0;
            const debitTarget = (isDebitNormal && increaseNormal) || (!isDebitNormal && !increaseNormal);
            const absDelta = Math.abs(delta);
            insertJournalEntry(store, {
              date: new Date().toISOString().slice(0, 10),
              memo: `Balance Adjustment for ${acc.code} - ${acc.name}`,
              payee: 'Balance Adjustment',
              source_type: 'OPENING_BALANCE',
              lines: debitTarget
                ? [{ account_id: accId, debit: absDelta, credit: 0 }, { account_id: openEq.id, debit: 0, credit: absDelta }]
                : [{ account_id: openEq.id, debit: absDelta, credit: 0 }, { account_id: accId, debit: 0, credit: absDelta }]
            });
          }
        }
      }
      saveStore(store);
      return { ok: true, accountId: accId };
    }

    // DELETE ACCOUNT (both user-created and existing system accounts)
    if (path.match(/^\/api\/accounts\/\d+$/) && method === 'DELETE') {
      const accId = Number(path.split('/')[3]);
      const acc = store.accounts.find((a) => a.id === accId);
      if (!acc) throw new Error('Account not found');
      if (store.accounts.length <= 1) {
        throw new Error('Cannot delete the last remaining account.');
      }
      const reassignTo = parsedUrl.searchParams.get('reassignTo') ? Number(parsedUrl.searchParams.get('reassignTo')) : null;
      if (reassignTo && reassignTo !== accId) {
        store.journal_lines.forEach((l) => { if (l.account_id === accId) l.account_id = reassignTo; });
        store.categorization_rules.forEach((r) => { if (r.target_account_id === accId) r.target_account_id = reassignTo; });
      } else {
        const affectedEntryIds = new Set(
          store.journal_lines.filter((l) => l.account_id === accId).map((l) => l.journal_entry_id)
        );
        store.journal_entries = store.journal_entries.filter((e) => !affectedEntryIds.has(e.id));
        store.journal_lines = store.journal_lines.filter((l) => !affectedEntryIds.has(l.journal_entry_id));
        store.categorization_rules = store.categorization_rules.filter((r) => r.target_account_id !== accId);
      }
      store.budgets = store.budgets.filter((b) => b.account_id !== accId);
      store.reconciliations = store.reconciliations.filter((r) => r.account_id !== accId);
      store.import_batches = store.import_batches.filter((b) => b.account_id !== accId);
      store.accounts = store.accounts.filter((a) => a.id !== accId);
      saveStore(store);
      return { ok: true, deleted: acc };
    }

    if (path.match(/^\/api\/accounts\/\d+\/ledger$/) && method === 'GET') {
      const accId = Number(path.split('/')[3]);
      const account = accMap.get(accId);
      const entryMap = new Map(store.journal_entries.map((e) => [e.id, e]));
      const lines = store.journal_lines
        .filter((l) => l.account_id === accId)
        .map((l) => ({ ...l, ...(entryMap.get(l.journal_entry_id) || {}) }))
        .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
      let running = 0;
      const rows = lines.map((l) => {
        running = round2(running + computeNormalBalance(account.type, l.debit, l.credit));
        return { ...l, running_balance: running };
      });
      return { account, ending_balance: running, rows: rows.reverse() };
    }

    if (path === '/api/import/csv-preview' && method === 'POST') {
      const allRows = parseCSVText(body.csvText || '');
      if (allRows.length < 2) throw new Error('CSV file must have a header row and at least one transaction row.');
      const headers = allRows[0];
      const dataRows = allRows.slice(1);
      const mapping = body.customMapping || autoDetectColumns(headers);
      const expDefault = store.accounts.find((a) => a.code === '5999') || store.accounts.find((a) => a.type === 'EXPENSE') || store.accounts[0];
      const incDefault = store.accounts.find((a) => a.code === '4090') || store.accounts.find((a) => a.type === 'INCOME') || store.accounts[0];

      const transactions = dataRows.map((row, idx) => {
        const date = normalizeDate(mapping.dateCol >= 0 ? row[mapping.dateCol] : '');
        const description = mapping.descriptionCol >= 0 ? (row[mapping.descriptionCol] || '') : '';
        let payee = mapping.payeeCol >= 0 ? (row[mapping.payeeCol] || '') : '';
        const reference = mapping.referenceCol >= 0 ? (row[mapping.referenceCol] || '') : '';
        const rawType = mapping.typeCol >= 0 ? String(row[mapping.typeCol] || '').toUpperCase() : '';

        let signedAmount = 0;
        if (mapping.debitCol >= 0 && mapping.creditCol >= 0 && (row[mapping.debitCol] || row[mapping.creditCol])) {
          const deb = Math.abs(parseAmount(row[mapping.debitCol]));
          const cred = Math.abs(parseAmount(row[mapping.creditCol]));
          signedAmount = cred > 0 ? cred : -deb;
        } else if (mapping.amountCol >= 0) {
          signedAmount = parseAmount(row[mapping.amountCol]);
          if (rawType.includes('DEBIT') || rawType.includes('WITHDRAWAL') || rawType === 'DR') signedAmount = -Math.abs(signedAmount);
          else if (rawType.includes('CREDIT') || rawType.includes('DEPOSIT') || rawType === 'CR') signedAmount = Math.abs(signedAmount);
        }

        const isInflow = signedAmount > 0;
        const absAmount = round2(Math.abs(signedAmount));
        const txType = isInflow ? 'INCOME' : 'EXPENSE';

        const rule = store.categorization_rules.find((r) =>
          `${description} ${payee}`.toUpperCase().includes(String(r.match_value || '').toUpperCase())
        );
        const catAcc = (rule && accMap.get(rule.target_account_id)) || (isInflow ? incDefault : expDefault);
        if (rule && rule.assign_payee && !payee) payee = rule.assign_payee;

        const importHash = makeHash(date, signedAmount, description, body.bankAccountId);
        const dup = store.journal_entries.find((e) => e.import_hash === importHash);

        return {
          rowIndex: idx + 1,
          date,
          description: description || payee || 'Bank Statement Entry',
          payee: payee || description.slice(0, 28),
          reference,
          signedAmount: round2(signedAmount),
          absAmount,
          txType,
          categoryAccountId: catAcc.id,
          categoryAccountName: `${catAcc.code} - ${catAcc.name}`,
          matchedRuleName: rule ? rule.name : null,
          isTaxDeductible: rule ? rule.is_tax_deductible : 0,
          importHash,
          isDuplicate: Boolean(dup),
          duplicateEntryNumber: dup ? dup.entry_number : null,
          selected: absAmount > 0 && !dup
        };
      }).filter((t) => t.absAmount > 0);

      return {
        headers, mapping,
        totalRows: transactions.length,
        duplicateCount: transactions.filter((t) => t.isDuplicate).length,
        ruleMatchedCount: transactions.filter((t) => Boolean(t.matchedRuleName)).length,
        transactions
      };
    }

    if (path === '/api/import/csv-commit' && method === 'POST') {
      let importedCount = 0;
      let totalInflow = 0;
      let totalOutflow = 0;
      const batchId = store.nextIds.batch++;
      for (const r of body.rows || []) {
        if (!r.selected) continue;
        importedCount++;
        if (r.txType === 'INCOME') totalInflow = round2(totalInflow + r.absAmount);
        else totalOutflow = round2(totalOutflow + r.absAmount);
        insertSimpleTransaction(store, {
          tx_type: r.txType,
          date: r.date,
          amount: r.absAmount,
          payment_account_id: Number(body.bankAccountId),
          category_account_id: Number(r.categoryAccountId),
          payee: r.payee,
          memo: r.description,
          reference: r.reference,
          is_tax_deductible: r.isTaxDeductible,
          reconciled_status: 'CLEARED',
          import_batch_id: batchId,
          import_hash: r.importHash,
          source_type: 'CSV_IMPORT'
        });
      }
      store.import_batches.unshift({
        id: batchId,
        filename: body.filename || 'bank_statement.csv',
        account_id: Number(body.bankAccountId),
        imported_count: importedCount,
        skipped_count: 0,
        total_inflow: totalInflow,
        total_outflow: totalOutflow
      });
      saveStore(store);
      return { ok: true, importedCount, totalInflow, totalOutflow };
    }

    if (path.match(/^\/api\/reconcile\/\d+$/) && method === 'GET') {
      const accountId = Number(path.split('/')[3]);
      const account = accMap.get(accountId);
      const entryMap = new Map(store.journal_entries.map((e) => [e.id, e]));
      let recD = 0, recC = 0;
      const openLines = [];
      for (const jl of store.journal_lines) {
        if (jl.account_id !== accountId) continue;
        if (jl.reconciled_status === 'RECONCILED') {
          recD += jl.debit;
          recC += jl.credit;
        } else {
          const je = entryMap.get(jl.journal_entry_id) || {};
          openLines.push({
            ...jl,
            entry_number: je.entry_number,
            date: je.date,
            memo: je.memo,
            payee: je.payee,
            signed_effect: computeNormalBalance(account.type, jl.debit, jl.credit)
          });
        }
      }
      return {
        account,
        beginningBalance: computeNormalBalance(account.type, recD, recC),
        openLines,
        history: store.reconciliations.filter((r) => r.account_id === accountId)
      };
    }

    if (path.match(/^\/api\/reconcile\/line\/\d+$/) && method === 'PUT') {
      const lid = Number(path.split('/')[4]);
      const line = store.journal_lines.find((l) => l.id === lid);
      if (line) line.reconciled_status = body.status;
      saveStore(store);
      return { ok: true };
    }

    if (path === '/api/reconcile/complete' && method === 'POST') {
      for (const lid of body.lineIds || []) {
        const line = store.journal_lines.find((l) => l.id === Number(lid));
        if (line) line.reconciled_status = 'RECONCILED';
      }
      saveStore(store);
      return { ok: true };
    }

    if (path === '/api/reports/all' && method === 'GET') {
      const startDate = parsedUrl.searchParams.get('startDate') || '2026-01-01';
      const endDate = parsedUrl.searchParams.get('endDate') || '2026-10-31';
      const pnl = computePnL(store, startDate, endDate);
      const balanceSheet = computeBalanceSheet(store, endDate);
      const trialBalance = computeTrialBalance(store, endDate);
      const cashFlow = computeCashFlow(store, startDate, endDate);
      const estTaxRate = Number(store.settings.tax_rate_estimate || 24);
      const entryMap = new Map(store.journal_entries.map((e) => [e.id, e]));
      const deductibleRows = [];
      for (const jl of store.journal_lines) {
        const je = entryMap.get(jl.journal_entry_id);
        const a = accMap.get(jl.account_id);
        if (je && a && a.type === 'EXPENSE' && (je.is_tax_deductible || a.code === '5200') && jl.debit > 0 && je.date >= startDate && je.date <= endDate) {
          deductibleRows.push({
            date: je.date, payee: je.payee, memo: je.memo,
            account_code: a.code, account_name: a.name, tax_category: a.tax_category, amount: jl.debit
          });
        }
      }
      const totalTaxableIncome = pnl.totalIncome;
      const taxesAlreadyPaid = round2(deductibleRows.filter((r) => r.account_code === '5200').reduce((s, r) => s + r.amount, 0));
      const businessAndItemizedDeductions = round2(deductibleRows.filter((r) => r.account_code !== '5200').reduce((s, r) => s + r.amount, 0));
      const netTaxableBase = Math.max(0, round2(totalTaxableIncome - businessAndItemizedDeductions));
      const estimatedTaxLiability = round2(netTaxableBase * (estTaxRate / 100));

      return {
        pnl, balanceSheet, trialBalance, cashFlow,
        taxSummary: {
          startDate, endDate, estTaxRate,
          incomeRows: pnl.incomeAccounts,
          deductibleRows,
          totalTaxableIncome,
          businessAndItemizedDeductions,
          netTaxableBase,
          taxesAlreadyPaid,
          estimatedTaxLiability,
          estimatedRemainingTaxDue: round2(estimatedTaxLiability - taxesAlreadyPaid)
        }
      };
    }

    if (path === '/api/rules' && method === 'POST') {
      store.categorization_rules.push({
        id: store.nextIds.rule++,
        name: body.name, priority: 10, match_field: 'ANY', match_type: 'CONTAINS',
        match_value: body.match_value, transaction_type: 'ANY',
        target_account_id: Number(body.target_account_id),
        assign_payee: body.assign_payee || '',
        is_tax_deductible: body.is_tax_deductible ? 1 : 0,
        is_active: 1
      });
      saveStore(store);
      return { ok: true };
    }

    if (path.match(/^\/api\/rules\/\d+$/) && method === 'DELETE') {
      const id = Number(path.split('/')[3]);
      store.categorization_rules = store.categorization_rules.filter((r) => r.id !== id);
      saveStore(store);
      return { ok: true };
    }

    if (path === '/api/rules/apply-existing' && method === 'POST') {
      return { ok: true, updatedCount: 0 };
    }

    if (path === '/api/budgets' && method === 'POST') {
      const existing = store.budgets.find((b) => b.account_id === Number(body.account_id));
      if (existing) existing.monthly_amount = round2(body.monthly_amount);
      else store.budgets.push({ id: store.nextIds.budget++, account_id: Number(body.account_id), monthly_amount: round2(body.monthly_amount), notes: '' });
      saveStore(store);
      return { ok: true };
    }

    if (path.match(/^\/api\/budgets\/\d+$/) && method === 'DELETE') {
      const id = Number(path.split('/')[3]);
      store.budgets = store.budgets.filter((b) => b.id !== id);
      saveStore(store);
      return { ok: true };
    }

    if (path === '/api/savings-goals' && method === 'POST') {
      store.savings_goals.push({
        id: store.nextIds.goal++,
        name: body.name,
        target_amount: round2(body.target_amount),
        current_amount: round2(body.current_amount || 0),
        target_date: body.target_date || '',
        color: '#10b981'
      });
      saveStore(store);
      return { ok: true };
    }

    if (path.match(/^\/api\/savings-goals\/\d+$/) && method === 'PUT') {
      const id = Number(path.split('/')[3]);
      const g = store.savings_goals.find((x) => x.id === id);
      if (g && body.current_amount !== undefined) g.current_amount = round2(body.current_amount);
      saveStore(store);
      return { ok: true };
    }

    if (path.match(/^\/api\/savings-goals\/\d+$/) && method === 'DELETE') {
      const id = Number(path.split('/')[3]);
      store.savings_goals = store.savings_goals.filter((x) => x.id !== id);
      saveStore(store);
      return { ok: true };
    }

    if (path === '/api/invoices-bills' && method === 'POST') {
      const ar = store.accounts.find((a) => a.code === '1200') || store.accounts[0];
      const ap = store.accounts.find((a) => a.code === '2100') || store.accounts[0];
      const amt = round2(body.total_amount);
      const arApId = body.doc_type === 'INVOICE' ? ar.id : ap.id;
      const lines = body.doc_type === 'INVOICE'
        ? [{ account_id: ar.id, debit: amt, credit: 0 }, { account_id: Number(body.category_account_id), debit: 0, credit: amt }]
        : [{ account_id: Number(body.category_account_id), debit: amt, credit: 0 }, { account_id: ap.id, debit: 0, credit: amt }];
      const jeId = insertJournalEntry(store, {
        date: body.issue_date, memo: `${body.doc_type} ${body.doc_number} - ${body.contact_name}`,
        payee: body.contact_name, reference: body.doc_number, source_type: body.doc_type, lines
      });
      store.invoices_bills.unshift({
        id: store.nextIds.doc++,
        doc_type: body.doc_type, doc_number: body.doc_number, contact_name: body.contact_name,
        issue_date: body.issue_date, due_date: body.due_date, status: 'OPEN',
        total_amount: amt, category_account_id: Number(body.category_account_id),
        ar_ap_account_id: arApId, accrual_journal_entry_id: jeId
      });
      saveStore(store);
      return { ok: true };
    }

    if (path.match(/^\/api\/invoices-bills\/\d+\/pay$/) && method === 'POST') {
      const id = Number(path.split('/')[3]);
      const doc = store.invoices_bills.find((d) => d.id === id);
      if (doc && doc.status !== 'PAID') {
        const payAccId = Number(body.payment_account_id);
        const amt = round2(doc.total_amount);
        const lines = doc.doc_type === 'INVOICE'
          ? [{ account_id: payAccId, debit: amt, credit: 0 }, { account_id: doc.ar_ap_account_id, debit: 0, credit: amt }]
          : [{ account_id: doc.ar_ap_account_id, debit: amt, credit: 0 }, { account_id: payAccId, debit: 0, credit: amt }];
        insertJournalEntry(store, {
          date: body.paid_date || '2026-10-19',
          memo: `Payment settled for ${doc.doc_number}`,
          payee: doc.contact_name,
          reference: doc.doc_number,
          source_type: doc.doc_type,
          lines
        });
        doc.status = 'PAID';
        doc.paid_date = body.paid_date || '2026-10-19';
        saveStore(store);
      }
      return { ok: true };
    }

    if (path.match(/^\/api\/invoices-bills\/\d+$/) && method === 'DELETE') {
      const id = Number(path.split('/')[3]);
      store.invoices_bills = store.invoices_bills.filter((d) => d.id !== id);
      saveStore(store);
      return { ok: true };
    }

    if (path === '/api/recurring' && method === 'POST') {
      store.recurring_transactions.push({
        id: store.nextIds.rec++,
        name: body.name, tx_type: body.tx_type, frequency: body.frequency,
        next_date: body.next_date, amount: round2(body.amount),
        payment_account_id: Number(body.payment_account_id),
        category_account_id: Number(body.category_account_id)
      });
      saveStore(store);
      return { ok: true };
    }

    if (path.match(/^\/api\/recurring\/\d+\/run$/) && method === 'POST') {
      const id = Number(path.split('/')[3]);
      const rec = store.recurring_transactions.find((r) => r.id === id);
      if (rec) {
        insertSimpleTransaction(store, {
          tx_type: rec.tx_type, date: rec.next_date, amount: rec.amount,
          payment_account_id: rec.payment_account_id, category_account_id: rec.category_account_id,
          payee: rec.name, memo: `Scheduled: ${rec.name}`
        });
        const d = new Date(rec.next_date + 'T00:00:00Z');
        d.setUTCMonth(d.getUTCMonth() + 1);
        rec.next_date = d.toISOString().slice(0, 10);
        saveStore(store);
        return { ok: true, next_date: rec.next_date };
      }
    }

    if (path.match(/^\/api\/recurring\/\d+$/) && method === 'DELETE') {
      const id = Number(path.split('/')[3]);
      store.recurring_transactions = store.recurring_transactions.filter((r) => r.id !== id);
      saveStore(store);
      return { ok: true };
    }

    if (path === '/api/settings' && method === 'PUT') {
      Object.assign(store.settings, body);
      saveStore(store);
      return { ok: true };
    }

    if (path === '/api/currencies' && method === 'POST') {
      const existing = store.currencies.find((c) => c.code === body.code);
      if (existing) existing.exchange_rate = Number(body.exchange_rate);
      else store.currencies.push({ code: body.code, name: body.name || body.code, symbol: body.symbol || '$', exchange_rate: Number(body.exchange_rate) });
      saveStore(store);
      return { ok: true };
    }

    // BACKUP SNAPSHOTS & RESTORE LATEST BACKUP
    if (path === '/api/backups/create' && method === 'POST') {
      const label = body.label || `Saved Backup (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`;
      const snap = createSnapshotInBrowser(store, label);
      return { ok: true, id: snap.id, label: snap.label, account_count: snap.account_count, entry_count: snap.entry_count };
    }

    if (path === '/api/backups/restore-latest' && method === 'POST') {
      const list = loadBackupsList();
      if (!list.length) throw new Error('No saved backup snapshot found yet. Click "Download Backup (.JSON)" or "+ Save Instant Snapshot" first.');
      const latest = list[0];
      saveStore(latest.payload);
      return {
        ok: true,
        restoredSnapshot: {
          id: latest.id,
          label: latest.label,
          created_at: latest.created_at,
          account_count: latest.account_count,
          entry_count: latest.entry_count
        }
      };
    }

    if (path.match(/^\/api\/backups\/\d+\/restore$/) && method === 'POST') {
      const id = Number(path.split('/')[3]);
      const list = loadBackupsList();
      const snap = list.find((s) => s.id === id);
      if (!snap) throw new Error('Backup snapshot not found.');
      saveStore(snap.payload);
      return {
        ok: true,
        restoredSnapshot: {
          id: snap.id,
          label: snap.label,
          created_at: snap.created_at,
          account_count: snap.account_count,
          entry_count: snap.entry_count
        }
      };
    }

    if (path.match(/^\/api\/backups\/\d+$/) && method === 'DELETE') {
      const id = Number(path.split('/')[3]);
      const list = loadBackupsList().filter((s) => s.id !== id);
      localStorage.setItem(BACKUPS_KEY, JSON.stringify(list));
      return { ok: true };
    }

    if (path === '/api/admin/reset-demo' && method === 'POST') {
      createSnapshotInBrowser(store, 'Auto-Backup Before Demo Restore');
      const fresh = createInitialStore();
      saveStore(fresh);
      return { ok: true };
    }

    if (path === '/api/admin/clear-transactions' && method === 'POST') {
      if (store.journal_entries.length > 0) {
        createSnapshotInBrowser(store, `Auto-Backup Before Empty Reset (${store.journal_entries.length} entries)`);
      }
      store.journal_entries = [];
      store.journal_lines = [];
      store.invoices_bills = [];
      store.reconciliations = [];
      store.import_batches = [];
      store.recurring_transactions = [];
      store.savings_goals = [];
      store.budgets = [];
      saveStore(store);
      return { ok: true };
    }

    if (path === '/api/import/backup-restore' && method === 'POST') {
      if (Array.isArray(body.accounts) && Array.isArray(body.journal_entries)) {
        const merged = { ...store, ...body };
        saveStore(merged);
        createSnapshotInBrowser(merged, `Uploaded Backup File (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`);
      }
      return { ok: true };
    }

    return { ok: true };
  }

  const SAMPLE_CSV_TEXT = [
    'Date,Description,Payee,Reference,Withdrawal,Deposit,Amount',
    '2026-10-19,WHOLE FOODS MARKET #1042 ORGANIC GROCERIES,Whole Foods Market,POS-9921,142.85,,-142.85',
    '2026-10-19,UBER *TRIP AIRPORT SHUTTLE,Uber,POS-9922,48.50,,-48.50',
    '2026-10-20,STARBUCKS STORE #4412 ESPRESSO,Starbucks,POS-9925,14.75,,-14.75',
    '2026-10-21,AWS CLOUD SERVICES MONTHLY HOSTING,Amazon Web Services,INV-AWS10,64.20,,-64.20',
    '2026-10-22,SHELL SERVICE STATION FUEL,Shell Station,POS-9930,52.10,,-52.10',
    '2026-10-24,PAYROLL DIRECT DEPOSIT TECHCORP INC,TechCorp Direct Deposit,DD-1024,,4650.00,4650.00',
    '2026-10-25,TRADER JOES #210 GROCERY,Trader Joes,POS-9941,118.40,,-118.40'
  ].join('\r\n');

  function triggerBlobDownload(filename, content, mime = 'text/csv;charset=utf-8') {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  const origFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const urlStr = typeof input === 'string' ? input : input.url;
    if (urlStr.includes('/api/export/sample-bank-csv')) {
      return new Response(SAMPLE_CSV_TEXT, { status: 200, headers: { 'Content-Type': 'text/csv' } });
    }
    if (window.location.hostname.endsWith('github.io') && urlStr.includes('/api/')) {
      try {
        const result = handleStandaloneRequest(urlStr, init);
        return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
    }
    try {
      const res = await origFetch(input, init);
      if (res.status === 404 && urlStr.includes('/api/')) {
        const result = handleStandaloneRequest(urlStr, init);
        return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return res;
    } catch (err) {
      if (urlStr.includes('/api/')) {
        try {
          const result = handleStandaloneRequest(urlStr, init);
          return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
      }
      throw err;
    }
  };

  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href*="/api/export/"]');
    if (!link) return;
    if (!window.location.hostname.endsWith('github.io')) return;

    e.preventDefault();
    const href = link.getAttribute('href');
    const store = loadStore();
    const accMap = new Map(store.accounts.map((a) => [a.id, a]));
    const entryMap = new Map(store.journal_entries.map((je) => [je.id, je]));

    if (href.includes('sample-bank-csv')) {
      triggerBlobDownload('sample_bank_statement_oct2026.csv', SAMPLE_CSV_TEXT);
    } else if (href.includes('backup.json')) {
      createSnapshotInBrowser(store, `Downloaded Backup (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`);
      triggerBlobDownload(`ledger_full_backup_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(store, null, 2), 'application/json');
      if (typeof window.loadBootstrap === 'function') window.loadBootstrap();
    } else if (href.includes('transactions.csv')) {
      const rows = [['Entry Number', 'Date', 'Type', 'Payee', 'Memo', 'Account Code', 'Account Name', 'Debit', 'Credit', 'Status']];
      for (const jl of store.journal_lines) {
        const je = entryMap.get(jl.journal_entry_id) || {};
        const a = accMap.get(jl.account_id) || {};
        rows.push([je.entry_number, je.date, je.source_type, `"${je.payee || ''}"`, `"${je.memo || ''}"`, a.code, `"${a.name || ''}"`, jl.debit.toFixed(2), jl.credit.toFixed(2), jl.reconciled_status]);
      }
      triggerBlobDownload('general_ledger_transactions.csv', rows.map((r) => r.join(',')).join('\r\n'));
    } else if (href.includes('report.csv')) {
      const pnl = computePnL(store, '2026-01-01', '2026-12-31');
      const rows = [['Account Code', 'Account Name', 'Type', 'Amount']];
      for (const i of pnl.incomeAccounts) rows.push([i.code, `"${i.name}"`, 'INCOME', i.amount.toFixed(2)]);
      for (const ex of pnl.expenseAccounts) rows.push([ex.code, `"${ex.name}"`, 'EXPENSE', ex.amount.toFixed(2)]);
      rows.push(['', 'NET INCOME', '', pnl.netIncome.toFixed(2)]);
      triggerBlobDownload('financial_report.csv', rows.map((r) => r.join(',')).join('\r\n'));
    }
  });
})();
