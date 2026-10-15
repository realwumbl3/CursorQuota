# CursorQuota

A small Chrome extension for keeping Cursor's included monthly usage on track.

On the Cursor **Spending** page, it adds a quota chart for Cursor Models and Other Models. Each chart shows:

- current usage
- daily budget for the remaining days
- average daily usage over the current monthly cycle
- estimated usage at reset if that cycle average continues
- daily usage totals that add up to current usage (expand for each date and total percentage)

Every visit to the Spending page records the usage bar's percentage width at full precision, falling back to the displayed percentage when that width is unavailable. Each chart spans the current billing period—from its start through the reset date—and projects forward from the latest point.

Usage labels and chart tooltips show the full captured precision. Calculated daily budgets and projections are displayed to one decimal place.

Daily usage is reconstructed from consecutive readings in the current billing cycle, shown newest first as a date and total percentage. Changes between visits on the same local day stay on that day. Changes spanning multiple days are estimated in proportion to elapsed time on each day, including daylight-saving changes. Usage before the first reading is allocated from zero at the assumed cycle start; today is partial. The daily totals include all current usage, with decimal arithmetic and largest-remainder rounding ensuring they add up exactly at the captured precision (at least five decimal places). When counters conflict, newer readings take priority and incompatible older readings are excluded from the reconstruction. Captured history is preserved.

The monthly cycle is estimated from the displayed reset date, with midnight assumed because the page does not give a reset time. Budgets, averages, and charts all use that same period, including months with 28, 29, 30, or 31 days. The chart expands its percentage scale to show projections above 100% in full. History from previous cycles is excluded.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this folder.
4. Open [Cursor Spending](https://cursor.com/dashboard/spending).

After updating the files, reload CursorQuota on the extensions page and refresh Spending.

## Verify

Run `node tests/content.test.cjs` for the billing-period and chart regression checks.
