//! GitHub review threads, read over GraphQL.
//!
//! The REST pull-request comments endpoint has no notion of thread resolution —
//! clicking "Resolve conversation" in the web UI leaves every REST field
//! untouched. `isResolved` exists only on the GraphQL `reviewThreads`
//! connection, so "show me what is still unresolved" has to go through GraphQL.
//! The same query also hands back the thread's file, line, and diff side in one
//! round trip, which is what lets the desktop diff anchor a thread to a row.

mod model;

use futures::{stream, StreamExt, TryStreamExt};
use serde_json::json;

use self::model::{GraphQlResponse, ReviewThreadNode, ThreadCommentsQueryData, ThreadsQueryData};
use crate::domain::git::forge::provider::{CommentThread, ForgeContext, ForgeError, PrComment};

/// Threads per request. GitHub's GraphQL cost budget scales with the product of
/// the nested page sizes, so keep the thread page modest and the comment page
/// generous — deep threads are rarer than many threads.
const THREAD_PAGE_SIZE: usize = 50;
const COMMENT_PAGE_SIZE: usize = 100;
/// Ceilings on pagination so a pathological PR cannot stall a status refresh.
/// Exceeding one is reported to the caller rather than silently truncated.
const MAX_THREAD_PAGES: usize = 10;
const MAX_COMMENT_PAGES: usize = 10;
const THREAD_COMMENT_CONCURRENCY: usize = 8;

const COMMENT_FIELDS: &str = "
  pageInfo { hasNextPage endCursor }
  nodes {
    body
    createdAt
    url
    author { login avatarUrl ... on User { name } }
  }
";

fn review_threads_query() -> String {
    format!(
        "
query($owner: String!, $name: String!, $number: Int!, $first: Int!, $comments: Int!, $cursor: String) {{
  repository(owner: $owner, name: $name) {{
    pullRequest(number: $number) {{
      reviewThreads(first: $first, after: $cursor) {{
        pageInfo {{ hasNextPage endCursor }}
        nodes {{
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          diffSide
          comments(first: $comments) {{{COMMENT_FIELDS}}}
        }}
      }}
    }}
  }}
}}
"
    )
}

/// Follow-up for a thread whose comments overflowed the first page. Addressing
/// the thread by node id keeps this independent of where it sat in the list.
fn thread_comments_query() -> String {
    format!(
        "
query($threadId: ID!, $comments: Int!, $cursor: String) {{
  node(id: $threadId) {{
    ... on PullRequestReviewThread {{
      comments(first: $comments, after: $cursor) {{{COMMENT_FIELDS}}}
    }}
  }}
}}
"
    )
}

/// GraphQL lives at a different path than REST on every GitHub deployment:
/// `api.github.com/graphql` for the hosted service, `<host>/api/graphql` for
/// Enterprise Server (whose REST base is `<host>/api/v3`).
pub(super) fn graphql_url(api_base_url: &str) -> String {
    let base = api_base_url.trim_end_matches('/');
    match base.strip_suffix("/api/v3") {
        Some(root) => format!("{root}/api/graphql"),
        None => format!("{base}/graphql"),
    }
}

pub(super) fn split_full_name(full_name: &str) -> Result<(&str, &str), ForgeError> {
    full_name.split_once('/').ok_or_else(|| {
        ForgeError::Response(format!(
            "GitHub returned an unusable repository: {full_name}"
        ))
    })
}

async fn post_query<T: serde::de::DeserializeOwned>(
    ctx: &ForgeContext,
    url: &str,
    body: serde_json::Value,
) -> Result<GraphQlResponse<T>, ForgeError> {
    let request = ctx
        .http
        .post(url)
        .bearer_auth(&ctx.credentials.token)
        .json(&body);
    ctx.http.request_json(request).await
}

/// A connection claiming another page without handing back a cursor leaves no
/// way to ask for the rest. Returning what we have would under-report the
/// review — the one failure mode the developer cannot see from the UI.
fn require_cursor(cursor: Option<String>, subject: &str) -> Result<String, ForgeError> {
    cursor.ok_or_else(|| {
        ForgeError::Response(format!(
            "GitHub reported more {subject} but returned no cursor to fetch them"
        ))
    })
}

pub(super) async fn fetch(
    ctx: &ForgeContext,
    repo_full_name: &str,
    pr_number: u64,
) -> Result<Vec<CommentThread>, ForgeError> {
    let (owner, name) = split_full_name(repo_full_name)?;
    let url = graphql_url(&ctx.api_base_url);
    let query = review_threads_query();
    let mut cursor: Option<String> = None;
    let mut threads = Vec::new();

    for _ in 0..MAX_THREAD_PAGES {
        let body = json!({
            "query": query,
            "variables": {
                "owner": owner,
                "name": name,
                "number": pr_number,
                "first": THREAD_PAGE_SIZE,
                "comments": COMMENT_PAGE_SIZE,
                "cursor": cursor,
            },
        });
        let response: GraphQlResponse<ThreadsQueryData> = post_query(ctx, &url, body).await?;
        let page = response.into_review_threads()?;
        let page_threads = stream::iter(
            page.nodes
                .into_iter()
                .map(|node| map_thread(ctx, &url, node)),
        )
        .buffered(THREAD_COMMENT_CONCURRENCY)
        .try_collect::<Vec<_>>()
        .await?;
        threads.extend(page_threads);
        if !page.page_info.has_next_page {
            return Ok(threads);
        }
        cursor = Some(require_cursor(page.page_info.end_cursor, "review threads")?);
    }

    Err(ForgeError::Response(format!(
        "This pull request has more than {} review threads; showing them all is not supported",
        THREAD_PAGE_SIZE * MAX_THREAD_PAGES
    )))
}

async fn map_thread(
    ctx: &ForgeContext,
    url: &str,
    node: ReviewThreadNode,
) -> Result<CommentThread, ForgeError> {
    let mut comments = node
        .comments
        .nodes
        .into_iter()
        .map(model::map_comment)
        .collect::<Vec<_>>();
    if node.comments.page_info.has_next_page {
        let cursor = require_cursor(
            node.comments.page_info.end_cursor,
            "comments on a review thread",
        )?;
        comments.extend(fetch_remaining_comments(ctx, url, &node.id, cursor).await?);
    }
    Ok(CommentThread {
        resolved: Some(node.is_resolved),
        outdated: node.is_outdated,
        file: node.path,
        // `line` is null once a thread goes outdated; `originalLine` still
        // records the row the reviewer wrote against. Consumers must read that
        // number as history rather than as a position in the current diff —
        // the `outdated` flag is what tells the two apart.
        line: node.line.or(node.original_line),
        side: node.diff_side.map(model::thread_side),
        id: node.id,
        comments,
    })
}

/// A thread with more than one page of replies is rare but real — a long
/// back-and-forth on a contested line. Dropping the tail would hand the
/// developer, and their agent, a conversation that stops mid-argument.
async fn fetch_remaining_comments(
    ctx: &ForgeContext,
    url: &str,
    thread_id: &str,
    first_cursor: String,
) -> Result<Vec<PrComment>, ForgeError> {
    let query = thread_comments_query();
    let mut cursor = first_cursor;
    let mut comments = Vec::new();

    for _ in 0..MAX_COMMENT_PAGES {
        let body = json!({
            "query": query,
            "variables": {
                "threadId": thread_id,
                "comments": COMMENT_PAGE_SIZE,
                "cursor": cursor,
            },
        });
        let response: GraphQlResponse<ThreadCommentsQueryData> = post_query(ctx, url, body).await?;
        let page = response.into_thread_comments()?;
        comments.extend(page.nodes.into_iter().map(model::map_comment));
        if !page.page_info.has_next_page {
            return Ok(comments);
        }
        cursor = require_cursor(page.page_info.end_cursor, "comments on a review thread")?;
    }

    Err(ForgeError::Response(format!(
        "A review thread here has more than {} comments; showing them all is not supported",
        COMMENT_PAGE_SIZE * MAX_COMMENT_PAGES
    )))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::domain::git::forge::provider::ThreadSide;
    use crate::domain::git::forge::test_support::{context, json_fixture_server};
    use crate::domain::git::host::GitHost;

    #[test]
    fn graphql_url_splits_hosted_and_enterprise_bases() {
        assert_eq!(
            graphql_url("https://api.github.com"),
            "https://api.github.com/graphql"
        );
        assert_eq!(
            graphql_url("https://ghe.example.com/api/v3"),
            "https://ghe.example.com/api/graphql"
        );
        assert_eq!(
            graphql_url("https://ghe.example.com/api/v3/"),
            "https://ghe.example.com/api/graphql"
        );
    }

    fn threads_page(has_next: bool, cursor: Option<&str>) -> serde_json::Value {
        serde_json::json!({
            "data": { "repository": { "pullRequest": { "reviewThreads": {
                "pageInfo": { "hasNextPage": has_next, "endCursor": cursor },
                "nodes": [{
                    "id": "PRRT_1",
                    "isResolved": false,
                    "isOutdated": false,
                    "path": "src/main.rs",
                    "line": 10,
                    "originalLine": 10,
                    "diffSide": "RIGHT",
                    "comments": {
                        "pageInfo": { "hasNextPage": false, "endCursor": null },
                        "nodes": [{
                            "body": "first",
                            "createdAt": "2026-07-01T10:00:00Z",
                            "url": null,
                            "author": { "login": "reviewer", "name": null, "avatarUrl": null },
                        }],
                    },
                }],
            } } } }
        })
    }

    #[tokio::test]
    async fn a_single_page_of_threads_maps_without_follow_up_requests() {
        let mut routes = HashMap::new();
        routes.insert("/graphql".into(), threads_page(false, None));
        let context = context(json_fixture_server(routes).await, GitHost::GitHub);

        let threads = fetch(&context, "acme/repo", 1)
            .await
            .expect("single page maps");

        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].comments.len(), 1);
        assert_eq!(threads[0].side, Some(ThreadSide::New));
    }

    #[tokio::test]
    async fn a_declared_next_page_without_a_cursor_is_an_error_not_a_short_result() {
        // Returning the first page here would report "3 unresolved" when there
        // are 30 — under-reporting a review is invisible from the UI.
        let mut routes = HashMap::new();
        routes.insert("/graphql".into(), threads_page(true, None));
        let context = context(json_fixture_server(routes).await, GitHost::GitHub);

        let error = match fetch(&context, "acme/repo", 1).await {
            Err(error) => error,
            Ok(threads) => panic!("expected an error, got {} threads", threads.len()),
        };

        assert!(matches!(error, ForgeError::Response(message)
            if message.contains("more review threads")));
    }

    #[tokio::test]
    async fn a_thread_whose_comments_overflow_reports_the_missing_cursor() {
        let mut page = threads_page(false, None);
        page["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"][0]["comments"]
            ["pageInfo"] = serde_json::json!({ "hasNextPage": true, "endCursor": null });
        let mut routes = HashMap::new();
        routes.insert("/graphql".into(), page);
        let context = context(json_fixture_server(routes).await, GitHost::GitHub);

        let error = match fetch(&context, "acme/repo", 1).await {
            Err(error) => error,
            Ok(_) => panic!("expected an error for a truncated thread"),
        };

        assert!(matches!(error, ForgeError::Response(message)
            if message.contains("comments on a review thread")));
    }
}
