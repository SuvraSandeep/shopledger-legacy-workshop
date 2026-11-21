var test = require('node:test');
var assert = require('node:assert/strict');

var pricing = require('../lib/pricing');
var invoice = require('../lib/invoice');
var orders = require('../lib/orders');
var reports = require('../lib/reports');

// Build the same stored order shape as the checkout path, without loading the JSON store.
function billedOrder(items, coupon) {
  var totals = pricing.computeTotals(items, coupon || '');
  var db = { nextOrderId: 1001, orders: [] };
  var order = orders.add(db, {
    date: '2021-11-20',
    customer: 'Test Customer',
    items: items,
    coupon: coupon || '',
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    total: totals.total
  });
  return { db: db, order: order, totals: totals };
}

test('an undiscounted default-rate item agrees with the billed order', function () {
  var sale = billedOrder([{ id: 1, name: 'Tea', hsn: '0902', price: 100, qty: 2 }]);
  var figures = invoice.computeInvoiceFigures(sale.order);

  assert.equal(sale.order.total, 236);
  assert.equal(sale.order.tax, 36);
  assert.deepEqual({ subtotal: figures.subtotal, discount: figures.discount, tax: figures.tax, total: figures.total },
    { subtotal: 200, discount: 0, tax: 36, total: 236 });
  assert.equal(reports.getGstReconciliation(sale.db).mismatchCount, 0);
});

test('invoice total and GST match a billed HSN item with a coupon', function () {
  var sale = billedOrder([{ id: 1, name: 'Indrayani Basmati Rice 5kg', hsn: '1006', price: 640, qty: 1 }], 'WELCOME');
  var figures = invoice.computeInvoiceFigures(sale.order);

  assert.deepEqual({ discount: sale.order.discount, tax: sale.order.tax, total: sale.order.total },
    { discount: 32, tax: 30.4, total: 638.4 });
  assert.deepEqual({ discount: figures.discount, tax: figures.tax, cgst: figures.cgst,
    sgst: figures.sgst, total: figures.total },
  { discount: 32, tax: 30.4, cgst: 15.2, sgst: 15.2, total: 638.4 });
  assert.equal(figures.rows[0].gstPercent, 5);
  assert.equal(reports.getGstReconciliation(sale.db).mismatchCount, 0);
  assert.doesNotMatch(invoice.render(sale.order), /Accountant Reconciliation Notice/);
});

test('invoice uses the billed 5% HSN slab', function () {
  var sale = billedOrder([{ id: 2, name: 'Rice', hsn: '1006', price: 100, qty: 2 }]);
  var figures = invoice.computeInvoiceFigures(sale.order);

  assert.deepEqual({ tax: sale.order.tax, total: sale.order.total }, { tax: 10, total: 210 });
  assert.deepEqual({ tax: figures.tax, cgst: figures.cgst, sgst: figures.sgst, total: figures.total },
    { tax: 10, cgst: 5, sgst: 5, total: 210 });
  assert.deepEqual({ gstPercent: figures.rows[0].gstPercent, lineTax: figures.rows[0].lineTax },
    { gstPercent: 5, lineTax: 10 });
});

test('invoice applies a percent coupon before GST like checkout', function () {
  var sale = billedOrder([{ id: 2, name: 'Rice', hsn: '1006', price: 1000, qty: 1 }], 'WELCOME');
  var figures = invoice.computeInvoiceFigures(sale.order);

  assert.deepEqual({ discount: sale.order.discount, tax: sale.order.tax, total: sale.order.total },
    { discount: 50, tax: 47.5, total: 997.5 });
  assert.deepEqual({ discount: figures.discount, tax: figures.tax, total: figures.total },
    { discount: 50, tax: 47.5, total: 997.5 });
  assert.doesNotMatch(invoice.render(sale.order), /Accountant Reconciliation Notice/);
});

test('invoice respects the checkout percent coupon cap', function () {
  var sale = billedOrder([{ id: 3, name: 'Tea', hsn: '0902', price: 2000, qty: 1 }], 'SAVE10');
  var figures = invoice.computeInvoiceFigures(sale.order);

  assert.deepEqual({ discount: sale.order.discount, tax: sale.order.tax, total: sale.order.total },
    { discount: 150, tax: 333, total: 2183 });
  assert.deepEqual({ discount: figures.discount, tax: figures.tax, total: figures.total },
    { discount: 150, tax: 333, total: 2183 });
});

test('invoice applies a valid flat coupon before GST like checkout', function () {
  var sale = billedOrder([{ id: 3, name: 'Tea', hsn: '0902', price: 400, qty: 1 }], 'FLAT50');
  var figures = invoice.computeInvoiceFigures(sale.order);

  assert.deepEqual({ discount: sale.order.discount, tax: sale.order.tax, total: sale.order.total },
    { discount: 50, tax: 63, total: 413 });
  assert.deepEqual({ discount: figures.discount, tax: figures.tax, cgst: figures.cgst,
    sgst: figures.sgst, total: figures.total },
  { discount: 50, tax: 63, cgst: 31.5, sgst: 31.5, total: 413 });
  assert.match(invoice.render(sale.order), /<td>Invoice Total<\/td><td class="r">[^<]*413\.00<\/td>/);
});

test('invoice does not apply a flat coupon below its checkout minimum', function () {
  var sale = billedOrder([{ id: 3, name: 'Tea', hsn: '0902', price: 100, qty: 1 }], 'FLAT50');
  var figures = invoice.computeInvoiceFigures(sale.order);

  assert.deepEqual({ discount: sale.order.discount, tax: sale.order.tax, total: sale.order.total },
    { discount: 0, tax: 18, total: 118 });
  assert.deepEqual({ discount: figures.discount, tax: figures.tax, total: figures.total },
    { discount: 0, tax: 18, total: 118 });
});

test('invoice respects an explicit zero GST rate', function () {
  var sale = billedOrder([{ id: 4, name: 'Exempt item', gstRate: 0, price: 100, qty: 1 }]);
  var figures = invoice.computeInvoiceFigures(sale.order);

  assert.deepEqual({ tax: sale.order.tax, total: sale.order.total }, { tax: 0, total: 100 });
  assert.deepEqual({ tax: figures.tax, total: figures.total, gstPercent: figures.rows[0].gstPercent },
    { tax: 0, total: 100, gstPercent: 0 });
});

test('invoice rounds GST per line like checkout', function () {
  var sale = billedOrder([
    { id: 5, name: 'Small tea A', hsn: '0902', price: 0.03, qty: 1 },
    { id: 6, name: 'Small tea B', hsn: '0902', price: 0.03, qty: 1 }
  ]);
  var figures = invoice.computeInvoiceFigures(sale.order);

  assert.deepEqual({ tax: sale.order.tax, total: sale.order.total }, { tax: 0.02, total: 0.08 });
  assert.deepEqual({ tax: figures.tax, total: figures.total }, { tax: 0.02, total: 0.08 });
  assert.deepEqual(figures.rows.map(function (row) { return row.lineTax; }), [0.01, 0.01]);
});

test('CURRENT BEHAVIOUR: tax-only stored mismatch is reported but printable invoice has no notice', function () {
  var sale = billedOrder([{ id: 2, name: 'Rice', hsn: '1006', price: 100, qty: 1 }]);
  sale.order.tax = 18;

  var result = reports.getGstReconciliation(sale.db);
  assert.equal(result.mismatchCount, 1);
  assert.equal(result.totalDelta, 0);
  assert.deepEqual({ ledgerTax: result.rows[0].ledgerTax, invoiceTax: result.rows[0].invoiceTax,
    delta: result.rows[0].delta, matched: result.rows[0].matched },
  { ledgerTax: 18, invoiceTax: 5, delta: 0, matched: false });
  assert.doesNotMatch(invoice.render(sale.order), /Accountant Reconciliation Notice/);
});
