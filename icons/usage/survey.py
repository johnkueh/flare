import os,re,sys,json,collections
ROOT=sys.argv[1] if len(sys.argv)>1 else os.path.expanduser('~/Projects')
REPOS=['agent-skills','flare','glp3-native','glp3wiki','glp3wiki-app','heycooked','ledgersignal','popkr.com','recipes.im','reels.chat','reelschat','snuglog','swingcam-ios','untrappable','subs.rip','cf-template']
EXT=('.ts','.tsx','.js','.jsx','.swift','.kt','.mdx')
SKIP={'node_modules','.git','dist','build','.next','Pods','.expo','DerivedData','.turbo'}
imp=re.compile(r'import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["\'](lucide-react(?:-native)?|@phosphor-icons/[\w-]+|phosphor-react(?:-native)?|@tabler/icons-react|@heroicons/react/[\w/]+|react-native-heroicons/\w+|@hugeicons/[\w-]+|react-icons/\w+|lucide-react/[\w-]+)["\']',re.S)
sf=re.compile(r'(?:systemName:\s*|systemImage:\s*|sfSymbol\s*[:=]\s*|SymbolView[^>]*?name=\{?|symbol:\s*|icon:\s*|systemImage\s*=\s*)"([a-z0-9]+(?:\.[a-z0-9]+)*)"')
mat=re.compile(r'Icons\.(?:Filled|Default|Outlined|Rounded|Sharp|TwoTone|AutoMirrored\.(?:Filled|Outlined|Rounded|Default))\.(\w+)')
vec=re.compile(r'<(Ionicons|MaterialIcons|MaterialCommunityIcons|Feather|FontAwesome\d?|AntDesign|Entypo)\b[^>]*?name=["\']([\w-]+)["\']')
res=collections.defaultdict(lambda: collections.Counter())
repos=collections.defaultdict(set)
for repo in REPOS:
  for dp,dn,fn in os.walk(os.path.join(ROOT,repo)):
    dn[:]=[d for d in dn if d not in SKIP]
    for f in fn:
      if not f.endswith(EXT): continue
      p=os.path.join(dp,f)
      try: s=open(p,errors='ignore').read()
      except: continue
      if len(s)>800000: continue
      for m in imp.finditer(s):
        lib=m.group(2).split('/')[0] if not m.group(2).startswith('@') else '/'.join(m.group(2).split('/')[:2])
        for n in m.group(1).split(','):
          n=n.strip().split(' as ')[0].strip()
          if not n or n.startswith('type ') or n in('LucideIcon','IconProps','Icon','LucideProps','IconWeight','IconContext'): continue
          # count usage occurrences in file (JSX/refs), min 1
          c=max(1,len(re.findall(r'\b'+re.escape(n)+r'\b',s))-1)
          res[('lib',lib,n)][repo]+=c
      for m in sf.finditer(s): res[('sf','sf',m.group(1))][repo]+=1
      for m in mat.finditer(s): res[('mat','material',m.group(1))][repo]+=1
      for m in vec.finditer(s): res[('vec',m.group(1),m.group(2))][repo]+=1
out=[]
for k,c in res.items(): out.append((sum(c.values()),len(c),k,dict(c)))
out.sort(key=lambda x:(-x[1],-x[0]))
json.dump([[a,b,list(k),c] for a,b,k,c in out],open('raw.json','w'))
for a,b,k,c in out[:400]: print(a,b,k[1],k[2],' '.join(sorted(c)))
print(len(out))
