"""Validate editable settings, regenerate browser files, optionally package a release."""
from pathlib import Path
import json,re,argparse,zipfile,hashlib
ROOT=Path(__file__).resolve().parents[1]
def luminance(color):
    rgb=[int(color[i:i+2],16)/255 for i in (1,3,5)]
    rgb=[c/12.92 if c<=.04045 else ((c+.055)/1.055)**2.4 for c in rgb]
    return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2]
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--zip',action='store_true');args=parser.parse_args()
    config=json.loads((ROOT/'02-system/brand-config.json').read_text());tokens=json.loads((ROOT/'02-system/tokens.json').read_text())
    if config['version']!=tokens['version']:raise ValueError('Configuration and token versions differ')
    if config['defaultMode'] not in config['modes']:raise ValueError('Unknown default mode')
    for mode in ('terraoi','powered','customer'):
        b=config['modes'][mode]
        for key in ('name','descriptor','tagline','logo','favicon','primary','onPrimary','accent','reportOwner','emailSenderName','documentPrefix','supportLabel','showPoweredBy'):
            if key not in b:raise ValueError(f'{mode}: missing {key}')
        for key in ('primary','accent','onPrimary'):
            if not re.fullmatch(r'#[0-9a-fA-F]{6}',b[key]):raise ValueError(f'{mode}: invalid color {key}')
        for key in ('logo','favicon'):
            p=(ROOT/b[key]).resolve()
            if ROOT.resolve() not in p.parents or not p.is_file():raise ValueError(f'{mode}: missing or nonlocal {key}')
        l1,l2=sorted((luminance(b['primary']),luminance(b['onPrimary'])))
        if (l2+.05)/(l1+.05)<4.5:raise ValueError(f'{mode}: primary button contrast is below 4.5:1')
        if type(b['showPoweredBy']) is not bool:raise ValueError('showPoweredBy must be boolean')
        if b['showPoweredBy'] != (mode=='powered'):raise ValueError(f'{mode}: inconsistent attribution setting')
    (ROOT/'02-system/brand-config.js').write_text('window.TERRAOI_BRANDS = '+json.dumps(config,indent=2)+';\n')
    names={'onPrimary':'on-primary'}
    variables={**tokens['semantic'],**tokens['status']}
    (ROOT/'02-system/token-vars.css').write_text(':root{\n'+''.join(f'  --{names.get(k,k)}: {v};\n' for k,v in variables.items())+'}\n')
    entries={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(ROOT.rglob('*')) if p.is_file() and p.name!='MANIFEST.json' and not any(x.startswith('.') or x=='__pycache__' for x in p.relative_to(ROOT).parts)}
    (ROOT/'MANIFEST.json').write_text(json.dumps({'version':config['version'],'algorithm':'SHA-256','files':entries},indent=2)+'\n')
    print('Validated three branding modes and primary button contrast. Browser files and manifest refreshed.')
    if args.zip:
        target=ROOT.parent/(ROOT.name+'.zip')
        with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as z:
            for p in sorted(ROOT.rglob('*')):
                if p.is_file() and not any(x.startswith('.') or x=='__pycache__' for x in p.relative_to(ROOT).parts):z.write(p,Path(ROOT.name)/p.relative_to(ROOT))
        with zipfile.ZipFile(target) as z:
            if z.testzip():raise RuntimeError('ZIP integrity check failed')
        print(f'Packaged {target.name}')
if __name__=='__main__':main()
