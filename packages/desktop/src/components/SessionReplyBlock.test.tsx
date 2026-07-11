import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SessionReplyBlock } from "./SessionReplyBlock";

const navigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  useGetFeature: () => ({
    data: { id: 1780, project_id: 6, title: "QA reply routing" },
    isLoading: false,
    isError: false,
  }),
}));

describe("SessionReplyBlock", () => {
  it("renders a linked feature title without protocol metadata", async () => {
    const user = userEvent.setup();
    render(
      <SessionReplyBlock
        reply={{
          responderSessionId: 3291,
          responderFeatureId: 1780,
          requestMessageId: 1959337,
          status: "completed",
          link: "spawned",
          body: "REPLY_ROUTING_SUCCESS",
        }}
      />,
    );

    const title = screen.getByRole("button", { name: "“QA reply routing”" });
    expect(title).toHaveAttribute("title", "Open conversation");
    expect(screen.getByText("REPLY_ROUTING_SUCCESS")).toBeInTheDocument();
    expect(screen.queryByText(/1959337/)).toBeNull();
    expect(screen.queryByText(/Feature 1780/)).toBeNull();
    expect(screen.queryByText(/cadencr-reply/)).toBeNull();

    await user.click(title);
    expect(navigate).toHaveBeenCalledWith({
      to: "/projects/$projectId/features/$featureId",
      params: { projectId: "6", featureId: "1780" },
    });
  });
});
