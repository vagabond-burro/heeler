#!/usr/bin/env python3
"""Check local guide links, image paths, heading anchors, and README reachability."""
from pathlib import Path
import re
import sys
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
GUIDE = ROOT / 'docs/user-guide'
LINK = re.compile(r'!?\[[^\]]*\]\(([^\n)]+)\)')


def anchors(path):
    text = path.read_text()
    result, counts = set(), {}
    for title in re.findall(r'^#{1,6}\s+(.+?)\s*#*$', text, re.M):
        title = re.sub(r'!?\[([^\]]+)\]\([^)]+\)', r'\1', title)
        title = re.sub(r'<[^>]+>', '', title).strip().lower()
        slug = re.sub(r'[^\w\- ]', '', title).replace(' ', '-')
        n = counts.get(slug, 0)
        counts[slug] = n + 1
        result.add(slug + (f'-{n}' if n else ''))
    result.update(re.findall(r'(?:id|name)=["\']([^"\']+)', text))
    return result


def check():
    pages = sorted(GUIDE.rglob('*.md'))
    errors, graph, checked = [], {}, 0
    for page in [*pages, ROOT / 'docs/whats-new.md']:
        graph[page] = set()
        text = re.sub(r'^```[^\n]*\n.*?^```\s*$', '', page.read_text(), flags=re.M | re.S)
        for target in LINK.findall(text):
            target = target.strip()
            if target.startswith('<'):
                target = target[1:target.index('>')]
            else:
                target = target.split(' "', 1)[0]
            if re.match(r'^[a-zA-Z][\w+.-]*:', target) or target.startswith('//'):
                continue
            location, _, fragment = unquote(target).partition('#')
            dest = (page.parent / location).resolve() if location else page
            checked += 1
            if not dest.exists():
                errors.append(f'{page.relative_to(ROOT)}: missing {target}')
            elif fragment and dest.suffix == '.md' and fragment not in anchors(dest):
                errors.append(f'{page.relative_to(ROOT)}: missing anchor {target}')
            elif dest.suffix == '.md':
                graph[page].add(dest)
    seen, todo = set(), [GUIDE / 'README.md']
    while todo:
        page = todo.pop()
        if page in seen:
            continue
        seen.add(page)
        todo.extend(graph.get(page, set()) - seen)
    for page in pages:
        if page not in seen:
            errors.append(f'Unreachable from guide README: {page.relative_to(ROOT)}')
    print(f'{len(pages)} guide pages; {checked} local links/images; {len(errors)} errors')
    for error in errors:
        print(error)
    return bool(errors)


if __name__ == '__main__':
    sys.exit(check())
