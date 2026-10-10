// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { rangeToEmailHtml } from "./email-export";

function selectContents(element: Element): Range {
  const range = document.createRange();
  range.selectNodeContents(element);
  return range;
}

describe("rangeToEmailHtml", () => {
  it("keeps semantic headings and foreground styling without a background", () => {
    const heading = document.createElement("h2");
    heading.className = "source-only-class";
    heading.style.cssText =
      "color:rgb(70, 80, 190);background-color:rgb(20, 20, 20);font-size:22px;font-weight:700";
    heading.textContent = "Release notes";
    document.body.append(heading);

    const html = rangeToEmailHtml(selectContents(heading));

    expect(html).toContain("<h2");
    expect(html).toContain("Release notes");
    expect(html).toContain("color:rgb(70, 80, 190)");
    expect(html).toContain("font-size:22px");
    expect(html).not.toContain("background");
    expect(html).not.toContain("source-only-class");
    heading.remove();
  });

  it("drops unsafe link targets while retaining their visible text", () => {
    const paragraph = document.createElement("p");
    paragraph.innerHTML = '<a href="javascript:alert(1)" onclick="alert(2)">Open me</a>';
    document.body.append(paragraph);

    const html = rangeToEmailHtml(selectContents(paragraph));

    expect(html).toContain("Open me");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("onclick");
    paragraph.remove();
  });

  it("preserves list and table containers for partial selections", () => {
    const container = document.createElement("div");
    container.innerHTML = `
      <ul><li><span id="list-target">List item</span></li></ul>
      <table><tbody><tr><td><span id="cell-target">Cell value</span></td></tr></tbody></table>
    `;
    document.body.append(container);

    const listHtml = rangeToEmailHtml(selectContents(container.querySelector("#list-target")!));
    const tableHtml = rangeToEmailHtml(selectContents(container.querySelector("#cell-target")!));

    expect(listHtml).toMatch(/^<ul[^>]*><li/);
    expect(tableHtml).toMatch(/^<table[^>]*><tbody[^>]*><tr[^>]*><td/);
    container.remove();
  });

  it("omits interactive controls from a copied block", () => {
    const container = document.createElement("div");
    container.innerHTML = "<p>Answer</p><button>Copy code</button>";
    document.body.append(container);

    const html = rangeToEmailHtml(selectContents(container));

    expect(html).toContain("Answer");
    expect(html).not.toContain("Copy code");
    expect(html).not.toContain("button");
    container.remove();
  });

  it("keeps absolute user-openable links without leaking relative or credentialed URLs", () => {
    const paragraph = document.createElement("p");
    paragraph.innerHTML = `
      <a href="https://example.com/docs">External</a>
      <a href="./docs/setup.md">Relative</a>
      <a href="https://user:secret@example.com/private">Credentialed</a>
      <a href="mailto:team@example.com">Email</a>
    `;
    document.body.append(paragraph);

    const html = rangeToEmailHtml(selectContents(paragraph));

    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('href="mailto:team@example.com"');
    expect(html).not.toContain("./docs/setup.md");
    expect(html).not.toContain("user:secret");
    paragraph.remove();
  });
});
