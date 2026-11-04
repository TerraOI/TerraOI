"""Generate editable Word templates from identity configuration. Optional python-docx dependency."""
from pathlib import Path
import argparse,json
from docx import Document
from docx.shared import Inches,Pt,RGBColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
ROOT=Path(__file__).resolve().parents[1]
def shade(cell,color):
    pr=cell._tc.get_or_add_tcPr();sh=OxmlElement('w:shd');sh.set(qn('w:fill'),color);pr.append(sh)
def create(mode,kind):
    cfg=json.loads((ROOT/'02-system/brand-config.json').read_text())['modes'][mode]
    doc=Document();sec=doc.sections[0]
    sec.page_width=Inches(8.27);sec.page_height=Inches(11.69)
    sec.top_margin=sec.bottom_margin=Inches(.75);sec.left_margin=sec.right_margin=Inches(.8)
    for name in ['Normal','Title','Subtitle','Heading 1','Heading 2']:
        st=doc.styles[name];st.font.name='Arial';st.font.color.rgb=RGBColor(0,0,0)
    for style in doc.styles:
        if style.type == 1:
            pr=style.element.find(qn('w:pPr'))
            if pr is not None:
                for border in list(pr.findall(qn('w:pBdr'))):pr.remove(border)
    doc.styles['Normal'].font.size=Pt(10.5);doc.styles['Normal'].paragraph_format.space_after=Pt(8)
    doc.styles['Normal'].paragraph_format.line_spacing=1.15
    doc.styles['Title'].font.size=Pt(28);doc.styles['Title'].paragraph_format.space_after=Pt(14)
    doc.styles['Heading 1'].font.size=Pt(16);doc.styles['Heading 1'].paragraph_format.space_before=Pt(16)
    doc.styles['Heading 2'].font.size=Pt(12)
    props=doc.core_properties;props.title=f'{cfg["name"]} '+('Operational coverage report' if kind=='report' else 'Operational decision record');props.author=cfg['name'];props.subject='Editable operational template';props.keywords='Operational Intelligence';props.last_modified_by=cfg['name'];props.comments=''
    logo=ROOT/cfg['logo'];png=logo.with_suffix('.png')
    if mode=='terraoi':png=ROOT/'01-identity/png/terraoi-logo-color.png'
    if not png.exists():raise FileNotFoundError(f'Provide a PNG logo at {png.relative_to(ROOT)}')
    doc.add_picture(str(png),width=Inches(2.3))
    doc.add_paragraph(cfg['descriptor'])
    doc.add_paragraph('Operational coverage report' if kind=='report' else 'Operational decision record',style='Title')
    doc.add_paragraph('Editable template  |  Replace bracketed fields before distribution.')
    doc.add_paragraph(f'Prepared for {cfg["reportOwner"]}')
    doc.add_paragraph(f'Document ID {cfg["documentPrefix"]}-[Number]    Date [Date]')
    if kind=='report':
        doc.add_paragraph('Executive summary',style='Heading 1')
        doc.add_paragraph('[Summarize scope, verified observations, material uncertainty, and the next decision. Distinguish proposed actions from completed work.]')
        doc.add_paragraph('Coverage by domain',style='Heading 1')
        t=doc.add_table(rows=1, cols=4);t.autofit=False
        widths=[1.05,1.0,2.0,2.55]
        for c,w in zip(t.columns,widths):c.width=Inches(w)
        for c,text in zip(t.rows[0].cells,['Domain','Coverage','Observation','Next step']):
            c.text=text;shade(c,cfg['primary'].lstrip('#'))
            for r in c.paragraphs[0].runs:r.font.color.rgb=RGBColor(255,255,255);r.bold=True
        repeat=OxmlElement('w:tblHeader');t.rows[0]._tr.get_or_add_trPr().append(repeat)
        for idx,domain in enumerate(['Air','Surface','Subsurface']):
            row=t.add_row()
            for c,text in zip(row.cells,[domain,'[Scope]','[Verified finding]','[Review or action]']):
                c.text=text
                if idx%2==0:shade(c,'F4F6F7')
        for row in t.rows:
            for c,w in zip(row.cells,widths):
                c.width=Inches(w);pr=c._tc.get_or_add_tcPr();borders=OxmlElement('w:tcBorders')
                for side in ['top','left','bottom','right']:
                    el=OxmlElement('w:'+side);el.set(qn('w:val'),'single');el.set(qn('w:sz'),'4');el.set(qn('w:color'),'D9D9D9');borders.append(el)
                pr.append(borders);m=OxmlElement('w:tcMar')
                for side in ['top','left','bottom','right']:
                    el=OxmlElement('w:'+side);el.set(qn('w:w'),'95');el.set(qn('w:type'),'dxa');m.append(el)
                pr.append(m)
                for p in c.paragraphs:p.paragraph_format.space_after=Pt(3);p.paragraph_format.space_before=Pt(3)
        doc.add_paragraph('Evidence and limitations',style='Heading 1')
        doc.add_paragraph('[List source IDs, observation times, known gaps, and limitations. Include a defensible basis for any confidence statement.]')
        doc.add_page_break()
        doc.add_paragraph('Agent activity and decisions',style='Heading 1')
        doc.add_paragraph('Record what the workflow observed, proposed, received approval for, and executed. Keep planned and completed actions separate.')
        for title,body in [('Observe','[Workflow ID, domain, source reference, collection time, and verified finding.]'),('Plan','[Proposed action, objective, scope, permissions, and expected result.]'),('Approve','[Approver, decision, timestamp, and any conditions. Mark pending if no approval is recorded.]'),('Act','[Actual execution status, actor, time, outcome, and exception or failure record.]')]:
            doc.add_paragraph(title,style='Heading 2');doc.add_paragraph(body)
        doc.add_paragraph('Follow up',style='Heading 1');doc.add_paragraph('[Record the responsible person, next step, due date, and review trigger.]')
        doc.add_paragraph('Source references',style='Heading 1');doc.add_paragraph('[Reference ID]  [Source title]  [Collection time]  [Link or repository location]')
    else:
        for title,body in [('Decision and purpose','[State the decision, its operational purpose, and the affected scope.]'),('Evidence and context','[Record verified observations, source IDs, timestamps, constraints, and uncertainty.]'),('Proposed action','[Describe the action, expected outcome, dependencies, and required permissions.]'),('Approval and outcome','[Record the approver, decision time, execution status, actual result, and exceptions. Leave execution status pending until confirmed.]'),('Follow up','[Name the owner, next action, and review date.]')]:
            doc.add_paragraph(title,style='Heading 1');doc.add_paragraph(body)
    footer=sec.footer.paragraphs[0];footer.text=cfg['name']+'  |  '+('Report' if kind=='report' else 'Decision record')
    if cfg['showPoweredBy']:footer.add_run('  |  Powered by TerraOI')
    footer.add_run('  |  ');field=OxmlElement('w:fldSimple');field.set(qn('w:instr'),'PAGE');footer._p.append(field)
    footer.style=doc.styles['Normal']
    for r in footer.runs:r.font.size=Pt(8)
    target=ROOT/'04-documents'/f'{mode}-{kind}-template.docx';target.parent.mkdir(parents=True,exist_ok=True);doc.save(target);print(target.name)
def main():
    p=argparse.ArgumentParser();p.add_argument('--mode',choices=['terraoi','customer','powered'],default='terraoi');args=p.parse_args()
    for kind in ['report','decision-record']:create(args.mode,kind)
if __name__=='__main__':main()
