import os, sys

base = os.path.dirname(os.path.abspath(__file__))

for filename in ['index.html', 'index_es.html']:
    path = os.path.join(base, '..', 'public', filename)  # adjust if needed
    path = os.path.normpath(path)
    
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()

    is_es = 'index_es' in filename
    label = 'Miembro' if is_es else 'Member'

    old = '${active             ? `<span class="result-badge badge-member">⭐ ' + label + '</span>` : \'\'}'
    new = old + '\n                            ${rental.apatel_member ? `<span class="result-badge" style="background:#1a3a6b;color:#7ec8e3;border:1px solid #3a5a8b;">🏨 APATEL</span>` : \'\'}'

    before = content.count('apatel_member')
    content = content.replace(old, new)
    after = content.count('apatel_member')

    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"{filename}: {before} -> {after} apatel_member occurrences")

print("Done — now run: git add public/index.html public/index_es.html && git commit -m 'Add APATEL badge to search results' && git push origin main")
