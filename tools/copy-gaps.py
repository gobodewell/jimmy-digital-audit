"""Writes the gap spreadsheet. Called by copy-gaps.js, which supplies the gaps.

The header row is copied from the real sheet rather than retyped, so the output
keeps its column order even if that sheet gains a column.
"""
import json, sys, openpyxl
from openpyxl.styles import Font, Alignment, PatternFill
from openpyxl.utils import get_column_letter

gaps, src_path, out_path = json.loads(sys.argv[1]), sys.argv[2], sys.argv[3]
headers = [c.value for c in openpyxl.load_workbook(src_path)['Final Use'][1]][:7]

wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Missing copy'
ws.append(headers)
for c in ws[1]:
    c.font = Font(bold=True, color='FFFFFF')
    c.fill = PatternFill('solid', fgColor='37006E')
    c.alignment = Alignment(vertical='center')

# The audit's own group names, mapped to the sheet's Section wording.
SEC = {'Channels': 'Social Media Review'}
for g in gaps:
    ws.append([g['cat'], SEC.get(g['grp'], g['grp']), g['aeo'], g['q'], None, '', ''])

ws.freeze_panes = 'A2'
for i, w in enumerate([12, 24, 7, 58, 9, 40, 64], 1):
    ws.column_dimensions[get_column_letter(i)].width = w
for row in ws.iter_rows(min_row=2):
    row[3].alignment = Alignment(wrap_text=True, vertical='top')
    row[6].alignment = Alignment(wrap_text=True, vertical='top')
    # The two cells to fill in, marked so they are findable at a glance.
    row[5].fill = PatternFill('solid', fgColor='FFF7E0')
    row[6].fill = PatternFill('solid', fgColor='FFF7E0')

ws2 = wb.create_sheet('Why these')
ws2.append(['Check id', 'Category', 'Score impact of the fix', 'Question', 'Why there is no copy'])
for c in ws2[1]:
    c.font = Font(bold=True, color='FFFFFF'); c.fill = PatternFill('solid', fgColor='37006E')
for g in gaps:
    why = 'No row with copy in the sheet for this question'
    ws2.append([g['id'], g['cat'], g['impact'], g['q'], why])
ws2.freeze_panes = 'A2'
for i, w in enumerate([11, 11, 21, 60, 52], 1):
    ws2.column_dimensions[get_column_letter(i)].width = w
for row in ws2.iter_rows(min_row=2):
    row[3].alignment = Alignment(wrap_text=True, vertical='top')
    row[4].alignment = Alignment(wrap_text=True, vertical='top')

wb.save(out_path)
print('wrote', out_path)
