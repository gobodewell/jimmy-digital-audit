"""Writes the full copy inventory. Called by copy-inventory.js.

Ranked by value, so the rows that matter are at the top and the ones still
missing copy are visible against what they are worth.
"""
import json, sys, openpyxl
from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
from openpyxl.utils import get_column_letter

rows, out_path = json.loads(sys.argv[1]), sys.argv[2]

wb = openpyxl.Workbook()
ws = wb.active; ws.title = 'All 40 checks'
HEAD = ['Rank', 'Value', 'Category', 'Section', 'AEO', 'Check id',
        'Question', 'Headline (Action Title)', 'Copy (Action Item text)', 'Source']
ws.append(HEAD)
for c in ws[1]:
    c.font = Font(bold=True, color='FFFFFF')
    c.fill = PatternFill('solid', fgColor='37006E')
    c.alignment = Alignment(vertical='center', wrap_text=True)

GAP   = PatternFill('solid', fgColor='FBEEF5')   # same magenta wash the report uses
DRAFT = PatternFill('solid', fgColor='FFF7E0')   # gold: written, not yet approved
THIN = Side(style='thin', color='E5E7EB')
for r in rows:
    label = {'approved': 'approved', 'draft': 'DRAFT'}.get(r['src'], 'NO COPY')
    ws.append([r['rank'], r['value'], r['cat'], r['grp'], r['aeo'], r['id'],
               r['q'], r['title'], r['text'], label])
    row = ws[ws.max_row]
    for c in row:
        c.alignment = Alignment(vertical='top', wrap_text=True)
        c.border = Border(bottom=THIN)
    # Flagged across the whole width: the point of the sheet is seeing what is
    # still unapproved against what it is worth. Gold for a draft awaiting
    # sign-off, magenta for a check with no copy from either source.
    if r['src'] == 'draft':
        for c in row: c.fill = DRAFT
        row[9].font = Font(bold=True, color='92400E')
    elif not r['text']:
        for c in row: c.fill = GAP
        row[9].font = Font(bold=True, color='87006E')
    row[1].font = Font(bold=True)

ws.freeze_panes = 'A2'
for i, w in enumerate([6, 8, 20, 24, 6, 11, 52, 40, 88, 12], 1):
    ws.column_dimensions[get_column_letter(i)].width = w
ws.auto_filter.ref = ws.dimensions

# A short second tab explaining the value column, so the ordering is not taken
# on faith by whoever opens this next.
ws2 = wb.create_sheet('About the value')
for line in [
    ['What "Value" means'],
    [''],
    ['Points added to the overall audit score if that one check flips to pass.'],
    [''],
    ['It is NOT the raw points on the check. Each category totals 100 raw points,'],
    ['but the categories are weighted: Company Visibility 40%, Website 35%,'],
    ['Social 25%. So raw points are not comparable between them -- a 20-point'],
    ['Social check is worth 2.00 and a 15-point Website check 2.10.'],
    [''],
    ['This is the same figure that orders "Do these five things first" on page 2'],
    ['of the report.'],
    [''],
    ['Source tells you whose words each recommendation uses.'],
    [''],
    ['  approved  from the Final Use tab of SA_Digital_Audit_Questions.'],
    ['  DRAFT     written for the tool and shaded gold. It prints today, but it'],
    ['            has not been signed off. Put the wording into the sheet and it'],
    ['            supersedes the draft automatically.'],
    ['  NO COPY   shaded magenta. Page 2 withholds the recommendation entirely'],
    ['            rather than inventing one, so a firm failing that check sees a'],
    ['            lower-value fix in its place.'],
]:
    ws2.append(line)
ws2['A1'].font = Font(bold=True, size=13, color='37006E')
ws2.column_dimensions['A'].width = 78

wb.save(out_path)
print('wrote', out_path)
