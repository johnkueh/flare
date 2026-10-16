import json,collections,math
from concepts import C
PROD={'heycooked':'Cooked','recipes.im':'Cooked','glp3-native':'GLP3','glp3wiki-app':'GLP3','glp3wiki':'GLP3 site','snuglog':'Snuglog','reelschat':'Reels.chat','reels.chat':'Reels.chat','ledgersignal':'LedgerSignal','popkr.com':'Popkr','untrappable':'Untrappable','swingcam-ios':'SwingCam','subs.rip':'subs.rip','flare':'Flare','agent-skills':'agent-skills','cf-template':'cf-template'}
alias={}
for k,v in C.items():
  for a in v.split(): alias[a]=k
d=json.load(open('raw.json'))
uses=collections.Counter(); prods=collections.defaultdict(set); un=collections.Counter()
for a,b,k,c in d:
  n=k[2]
  if n in('HugeiconsIcon','IconSvgElement'): continue
  con=alias.get(n) or alias.get(n.removesuffix('Icon'))
  if not con: un[n]+=a; continue
  for r,cnt in c.items(): uses[con]+=cnt; prods[con].add(PROD[r])
rows=sorted(uses,key=lambda x:(-len(prods[x]),-uses[x]))
json.dump([[r,uses[r],sorted(prods[r])] for r in rows],open('ranked.json','w'),indent=0)
for i,r in enumerate(rows,1): print(i,r,uses[r],len(prods[r]),','.join(sorted(prods[r])))
print('UNMAPPED',un.most_common(60))
