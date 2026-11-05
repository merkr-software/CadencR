"""Meaningful language-feature probes; initializing alone never passes these."""

FIXTURES = {
    "typescript-language-server": {"file": "example.ts", "language": "typescript",
        "text": "const value: string = 42;\nvalue;\n", "feature": "diagnostics", "expected": "2322"},
    "pyright": {"file": "example.py", "language": "python", "text": "value: str = 42\n",
                "feature": "diagnostics", "expected": "reportAssignmentType"},
    "json-language-server": {"file": "example.json", "language": "json", "text": '{"value": }\n',
                             "feature": "diagnostics", "expected": ""},
    "yaml-language-server": {"file": "example.yaml", "language": "yaml", "text": "value: [1\n",
                             "feature": "diagnostics", "expected": ""},
    "css-language-server": {"file": "example.css", "language": "css", "text": "a { colr: red; }\n",
                            "feature": "diagnostics", "expected": "unknownProperties"},
    "html-language-server": {"file": "example.html", "language": "html", "text": "<h1>Hello</h1>\n",
                             "feature": "hover", "position": {"line": 0, "character": 2}, "expected": "heading"},
    "svelte-language-server": {"file": "example.svelte", "language": "svelte",
        "text": '<script lang="ts">let value: string = 42;</script>\n<p>{value}</p>\n',
        "feature": "diagnostics", "expected": "2322"},
    "vue-language-server": {"file": "example.vue", "language": "vue",
        "text": '<script setup lang="ts">const value: string = 42;</script>\n<template><p>{{value}}</p></template>\n',
        "feature": "diagnostics", "expected": "2322"},
    "astro-ls": {"file": "example.astro", "language": "astro",
        "text": "---\nconst value: string = 42;\n---\n<h1>{value}</h1>\n",
        "feature": "diagnostics", "expected": "2322"},
    "bash-language-server": {"file": "example.sh", "language": "shellscript",
        "text": "function greet() {\n  echo hello\n}\n", "feature": "documentSymbol", "expected": "greet"},
    "docker-langserver": {"file": "Dockerfile", "language": "dockerfile", "text": "FROM alpine\nRUN echo hello\n",
        "feature": "hover", "position": {"line": 0, "character": 2}, "expected": "FROM"},
    "tailwindcss-language-server": {"file": "example.html", "language": "html",
        "text": '<div class="bg-r"></div>\n', "feature": "completion",
        "position": {"line": 0, "character": 16}, "expected": "bg-red"},
    "graphql-language-server": {"file": "example.graphql", "language": "graphql",
        "text": "query Example { unknownField }\n", "feature": "diagnostics", "expected": "unknownField"},
    "eslint": {"file": "example.js", "language": "javascript", "text": "const unused = 1;\n",
               "feature": "diagnostics", "expected": "no-unused-vars", "pull": True},
}


def prepare_workspace(identifier, workspace):
    fixture = FIXTURES[identifier]
    file = workspace / fixture["file"]
    file.write_text(fixture["text"])
    (workspace / "package.json").write_text('{"name":"cadencr-offline-smoke","private":true}\n')
    if identifier in ("typescript-language-server", "svelte-language-server", "vue-language-server", "astro-ls"):
        (workspace / "tsconfig.json").write_text('{"compilerOptions":{"strict":true,"noEmit":true}}\n')
    if identifier == "graphql-language-server":
        (workspace / "graphql.config.yml").write_text('schema: "schema.graphql"\ndocuments: "example.graphql"\n')
        (workspace / "schema.graphql").write_text("type Query { hello: String }\n")
    if identifier == "eslint":
        (workspace / "eslint.config.mjs").write_text('export default [{ rules: { "no-unused-vars": "error" } }];\n')
    if identifier == "tailwindcss-language-server":
        (workspace / "styles.css").write_text('@import "tailwindcss";\n')
    return file, fixture


def settings(identifier, workspace, bundle):
    values = {
        "python": {"analysis": {"typeCheckingMode": "basic", "diagnosticMode": "openFilesOnly"}},
        "python.analysis": {"typeCheckingMode": "basic", "diagnosticMode": "openFilesOnly"},
        "yaml": {"validate": True, "schemaStore": {"enable": False}},
        "css": {"validate": True, "lint": {"unknownProperties": "warning"}},
        "bashIde": {"shellcheckPath": "", "shfmt": {"path": ""}},
        "typescript": {"tsdk": str(bundle / "node_modules/typescript/lib")},
    }
    eslint = {"validate": "on", "packageManager": "npm", "useESLintClass": False,
        "useFlatConfig": True, "experimental": {"useFlatConfig": False}, "run": "onType",
        "nodePath": str(workspace / "node_modules"), "workspaceFolder": {"uri": workspace.as_uri(), "name": "smoke"},
        "workingDirectory": {"directory": str(workspace)}, "codeAction": {"disableRuleComment": {"enable": True},
        "showDocumentation": {"enable": True}}, "codeActionOnSave": {"enable": False, "mode": "all"},
        "format": False, "quiet": False, "onIgnoredFiles": "off", "options": {}, "rulesCustomizations": [],
        "problems": {"shortenToSingleLine": False}}
    return lambda section: eslint if identifier == "eslint" else values.get(section, {})
