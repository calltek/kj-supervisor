import { describe, expect, test } from 'bun:test'
import { buildSeedScript, shellQuote } from './seed-script'

const file = (path: string) => ({ path, content: 'x' })

describe('shellQuote', () => {
    test('wraps in single quotes and escapes embedded ones', () => {
        expect(shellQuote('a')).toBe("'a'")
        expect(shellQuote("a'b")).toBe(`'a'${'\\'}''b'`)
    })
})

describe('buildSeedScript — hostile input', () => {
    const hostile = [
        'a;rm -rf /.md',
        'a"b.md',
        "a'b.md",
        'a$(id).md',
        'a`id`.md',
        'a b.md',
        'a|b.md',
        'a&b.md',
        'a\nb.md',
        '../evil.md',
        'a/../../evil.md',
        'a/./b.md',
        'a//b.md',
        '/etc/passwd',
        'a\0b.md',
        '..',
        '',
    ]
    for (const path of hostile) {
        test(`rejects path ${JSON.stringify(path)}`, () => {
            expect(() =>
                buildSeedScript({ target_dir: '.claude/memories', files: [file(path)] })
            ).toThrow()
        })
    }

    for (const dir of ['../x', '/etc', 'a;b', 'a"b', '$(id)', 'a/../b', 'a//b', '', 'a\0b']) {
        test(`rejects target_dir ${JSON.stringify(dir)}`, () => {
            expect(() => buildSeedScript({ target_dir: dir, files: [file('a.md')] })).toThrow()
        })
    }

    test('one bad file aborts the whole script', () => {
        expect(() =>
            buildSeedScript({ target_dir: '.kj', files: [file('ok.md'), file('../bad')] })
        ).toThrow()
    })
})

describe('buildSeedScript — legitimate input', () => {
    test('memories with subfolders and skills are single-quoted', () => {
        const { script } = buildSeedScript({
            target_dir: '.claude/memories',
            purge: true,
            files: [file('comercial/oferta.md'), file('a.b-c_d.md')],
        })
        expect(script).toContain("mkdir -p '/v/.claude/memories/comercial'")
        expect(script).toContain("rm -f '/v/.claude/memories/comercial/oferta.md'")
        expect(script).toContain("base64 -d > '/v/.claude/memories/comercial/oferta.md'")
        expect(script).toContain("find '/v/.claude/memories' -mindepth 1 -delete")
        expect(script).toContain("chown -R 1000:1000 '/v/.claude/memories'")
        expect(script).not.toContain('"/v/')
    })

    test('skill SKILL.md, readonly .kj files and target_dir "."', () => {
        const skills = buildSeedScript({
            target_dir: '.claude/skills/',
            files: [file('mi-skill/SKILL.md')],
        })
        expect(skills.targetDir).toBe('.claude/skills')
        expect(skills.script).toContain("'/v/.claude/skills/mi-skill/SKILL.md'")

        const kj = buildSeedScript({
            target_dir: '.kj',
            files: [{ path: 'mcp-servers.json', content: '{}', readonly: true }],
        })
        expect(kj.script).toContain("chmod 0444 '/v/.kj/mcp-servers.json'")

        const root = buildSeedScript({ target_dir: '.', files: [file('CLAUDE.md')] })
        expect(root.script).toContain("rm -f '/v/./CLAUDE.md'")
    })
})
