// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { tableToMarkdown } from "./table-to-markdown";

function table(html: string): HTMLTableElement {
  const host = document.createElement("div");
  host.innerHTML = `<table>${html}</table>`;
  const element = host.querySelector("table");
  if (!element) throw new Error("no table");
  return element;
}

describe("tableToMarkdown", () => {
  it("writes the header, its separator and the rows, inline marks kept", () => {
    const markdown = tableToMarkdown(
      table(
        "<thead><tr><th>file</th><th>purpose</th></tr></thead>" +
          "<tbody><tr><td><code>a.py</code></td><td>First\nline</td></tr></tbody>",
      ),
    );
    expect(markdown).toBe("| file | purpose |\n| --- | --- |\n| `a.py` | First<br>line |");
  });

  it("keeps a cell's line breaks as <br>", () => {
    const markdown = tableToMarkdown(
      table("<tr><th>a</th></tr><tr><td>one<br>two<br/> three | four</td></tr>"),
    );
    expect(markdown).toBe("| a |\n| --- |\n| one<br>two<br>three \\| four |");
  });

  it("pads short rows and escapes pipes", () => {
    const markdown = tableToMarkdown(table("<tr><th>a</th><th>b</th></tr><tr><td>x | y</td></tr>"));
    expect(markdown).toBe("| a | b |\n| --- | --- |\n| x \\| y |  |");
  });

  it("is empty for an empty table", () => {
    expect(tableToMarkdown(table(""))).toBe("");
  });
});
