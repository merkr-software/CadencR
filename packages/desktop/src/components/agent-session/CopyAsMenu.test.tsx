import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { CopyAsMenu } from "./CopyAsMenu";

const copyAs = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const rangeToEmailHtml = vi.hoisted(() =>
  vi.fn((range: Range) => `<html>${range.commonAncestorContainer.textContent ?? ""}</html>`),
);
const useIsTouchDevice = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/lib/markdown-export", () => ({ copyAs }));
vi.mock("@/lib/email-export", () => ({ rangeToEmailHtml }));
vi.mock("@/hooks/useIsTouchDevice", () => ({ useIsTouchDevice }));

const noSource = { current: null };

describe("CopyAsMenu", () => {
  beforeEach(() => {
    copyAs.mockClear();
    rangeToEmailHtml.mockClear();
    useIsTouchDevice.mockReturnValue(true);
  });

  it("renders nothing on pointer devices, where the right-click menu has these", () => {
    useIsTouchDevice.mockReturnValue(false);
    render(<CopyAsMenu content="**hi**" sourceRef={noSource} />);
    expect(screen.queryByRole("button", { name: /Copy as/ })).not.toBeInTheDocument();
  });

  it("copies the message source in the picked format", async () => {
    const { user } = render(<CopyAsMenu content="**hi**" sourceRef={noSource} />);
    await user.click(screen.getByRole("button", { name: /Copy as/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Slack mrkdwn" }));
    expect(copyAs).toHaveBeenCalledWith("slack", "**hi**", undefined);
  });

  it("serializes the referenced source element — not the action row — for email", async () => {
    const source = document.createElement("p");
    source.textContent = "Rendered body";
    document.body.append(source);
    const { user } = render(<CopyAsMenu content="Body" sourceRef={{ current: source }} />);

    await user.click(screen.getByRole("button", { name: /Copy as/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Email" }));

    expect(rangeToEmailHtml.mock.calls[0]?.[0].commonAncestorContainer).toBe(source);
    expect(copyAs).toHaveBeenCalledWith("email", "Body", "<html>Rendered body</html>");
    source.remove();
  });
});
