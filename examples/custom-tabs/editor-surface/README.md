# Example editor surface

An editor contribution with no filesystem effects. The same isolated guest can
run as a tab or editor; the page reports its surface identity, visibility, focus
and editor appearance. `editor.open` acknowledges `{path, line, column}`;
`snapshot` returns the most recent acknowledged navigation.

Build from the repository root:

```bash
pnpm rust -- build -p cadencr-tab-backend --example editor
mkdir -p examples/custom-tabs/editor-surface/bin
cp target/debug/examples/editor examples/custom-tabs/editor-surface/bin/editor
pnpm --filter @cadencr/desktop exec vite build --config ../../examples/custom-tabs/editor-surface/vite.config.ts
```

Install the folder as a local tab and enable it with native-backend consent.
The tab strip opens its `tab` surface. `PluginEditorSurface` is the host
primitive for embedding the same page in an editor pane; editor selection and
file navigation are connected in the following implementation step.

The example uses the checkout's unreleased SDK. Only copy a binary built for
the platform on which the example will run.
