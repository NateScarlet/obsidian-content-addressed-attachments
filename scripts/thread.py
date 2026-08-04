#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys

#region Helper Functions

def run_cmd(args, input_str=None):
    """Run a system command and return stdout. Raises Exception on error."""
    kwargs = {
        "input": input_str,
        "text": True,
        "encoding": "utf-8",
        "capture_output": True
    }
    if os.name == "nt":
        kwargs["creationflags"] = 0x08000000  # subprocess.CREATE_NO_WINDOW

    result = subprocess.run(
        args,
        **kwargs
    )
    if result.returncode != 0:
        raise RuntimeError(f"Command {' '.join(args)} failed with exit code {result.returncode}:\n{result.stderr.strip()}")
    return result.stdout.strip()

def check_gh_installed():
    """Verify that gh CLI is installed and available."""
    try:
        run_cmd(["gh", "--version"])
    except Exception as e:
        sys.stderr.write("Error: GitHub CLI ('gh') is not installed or not in PATH.\n")
        sys.exit(1)

def get_repo_owner_and_name(args=None):
    """Retrieve owner and repo name from the specified --repo argument or local git directory."""
    if hasattr(args, "repo") and args.repo:
        if "/" in args.repo:
            parts = args.repo.split("/", 1)
            return parts[0], parts[1]
        else:
            sys.stderr.write("Error: Repo argument must be in format 'owner/repo'.\n")
            sys.exit(1)

    try:
        output = run_cmd(["gh", "repo", "view", "--json", "owner,name"])
        data = json.loads(output)
        return data["owner"]["login"], data["name"]
    except Exception as e:
        sys.stderr.write(f"Error: Failed to get repository owner and name: {e}\n")
        sys.exit(1)

def get_pr_number():
    """Detect current branch's PR number. Exits if not found."""
    try:
        output = run_cmd(["gh", "pr", "view", "--json", "number"])
        data = json.loads(output)
        return int(data["number"])
    except Exception as e:
        sys.stderr.write(f"Error: No pull request found for the current branch. Please specify PR number manually via '--pr'.\nDetail: {e}\n")
        sys.exit(1)

def run_graphql(query, variables=None):
    """Execute a GraphQL query/mutation using 'gh api graphql --input -'."""
    payload = {"query": query}
    if variables:
        payload["variables"] = variables
    
    output = run_cmd(["gh", "api", "graphql", "--input", "-"], input_str=json.dumps(payload))
    data = json.loads(output)
    
    # GraphQL returns errors array if query failed
    if "errors" in data and data["errors"]:
        error_msg = json.dumps(data["errors"], indent=2)
        raise RuntimeError(f"GraphQL returned errors:\n{error_msg}")
        
    return data

#endregion

#region Shared Thread Helpers

def _filter_threads(threads, args):
    """Filter and process raw GraphQL thread nodes into unified thread dicts."""
    filtered = []
    for t in threads:
        if not args.all and t.get("isResolved", False):
            continue

        if args.path:
            thread_path = t.get("path") or ""
            if args.path.lower() not in thread_path.lower():
                continue

        subject_type = t.get("subjectType")
        is_outdated = t.get("isOutdated", False)

        line = t.get("line")
        start_line = t.get("startLine")
        if is_outdated:
            if line is None:
                line = t.get("originalLine")
            if start_line is None:
                start_line = t.get("originalStartLine")
        if subject_type == "FILE":
            line = None
            start_line = None

        comments_conn = t.get("comments") or {}
        comments_nodes = comments_conn.get("nodes") or []
        has_prev_comments = (comments_conn.get("pageInfo") or {}).get("hasPreviousPage", False)
        comments = []
        for c in comments_nodes:
            body = c.get("body", "") or ""
            author = c.get("author", {}).get("login") if c.get("author") else "ghost"
            if body.startswith("🤖"):
                author = "Assistant"
                body = body[len("🤖"):]
                if body.startswith(" "):
                    body = body[1:]
            comments.append({
                "id": c.get("id"),
                "author": author,
                "body": body,
                "createdAt": c.get("createdAt")
            })

        if args.author:
            author_match = any(c["author"].lower() == args.author.lower() for c in comments)
            if not author_match:
                continue

        filtered.append({
            "id": t.get("id"),
            "isResolved": t.get("isResolved", False),
            "path": t.get("path"),
            "startLine": start_line,
            "line": line,
            "isOutdated": is_outdated,
            "comments": comments,
            "hasPreviousComments": has_prev_comments
        })
    return filtered

def _print_threads(filtered_threads, args):
    """Print filtered threads to stdout."""
    if not filtered_threads:
        print("No matching review comments found.")
        print("The PR may have no unresolved comments, or the filters may be too restrictive. Try `--all` to see all comments.")
        return

    for t in filtered_threads:
        print(f"ID:   {t['id']}")
        status_str = f" ({'Resolved' if t['isResolved'] else 'Unresolved'})" if args.all else ""

        line_suffix = ""
        if t.get("line") is not None:
            if t.get("startLine") and t["startLine"] != t["line"]:
                line_suffix = f":L{t['startLine']}-L{t['line']}"
                if t.get("isOutdated"):
                    line_suffix += " (range outdated)"
            else:
                line_suffix = f":{t['line']}"
                if t.get("isOutdated"):
                    line_suffix += " (line outdated)"

        print(f"File: {t['path']}{line_suffix}{status_str}")
        print("Comments:")
        if t.get("hasPreviousComments"):
            print("  - ... [omitted older comments] ...")
        for c in t['comments']:
            print(f"  - [{c['author']}]: {c['body']}")
        print("---")

#endregion

#region Action: List

def action_list(args):
    owner, repo = get_repo_owner_and_name(args)
    pr_number = args.pr if args.pr is not None else get_pr_number()
    
    # GraphQL query with cursor pagination for reviewThreads and last 50 comments for each thread
    query = """
    query($owner: String!, $repo: String!, $prNumber: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          reviewThreads(first: 100, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              isResolved
              path
              subjectType
              startLine
              line
              originalStartLine
              originalLine
              isOutdated
              comments(last: 50) {
                pageInfo {
                  hasPreviousPage
                }
                nodes {
                  id
                  body
                  author {
                    login
                  }
                  createdAt
                }
              }
            }
          }
        }
      }
    }
    """
    
    threads = []
    has_next_page = True
    cursor = None
    
    # Fetch review threads in a loop until all pages are retrieved
    while has_next_page:
        variables = {"owner": owner, "repo": repo, "prNumber": pr_number}
        if cursor:
            variables["cursor"] = cursor
            
        result = run_graphql(query, variables)
        
        pull_request = result.get("data", {}).get("repository", {}).get("pullRequest")
        if not pull_request:
            sys.stderr.write(f"Error: Pull Request #{pr_number} not found in repository {owner}/{repo}.\n")
            sys.exit(1)
            
        threads_conn = pull_request.get("reviewThreads") or {}
        threads.extend(threads_conn.get("nodes") or [])
        
        page_info = threads_conn.get("pageInfo") or {}
        has_next_page = page_info.get("hasNextPage", False)
        cursor = page_info.get("endCursor")
        
    # Process and filter threads on the client-side
    filtered_threads = _filter_threads(threads, args)
    _print_threads(filtered_threads, args)

#endregion

#region Action: Overview

def action_overview(args):
    """List inline review threads and global PR body/comments in a unified view."""
    owner, repo = get_repo_owner_and_name(args)
    pr_number = args.pr if args.pr is not None else get_pr_number()

    # Single GraphQL query to fetch both review threads and PR body/comments
    query = """
    query($owner: String!, $repo: String!, $prNumber: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          body
          comments(first: 100) {
            nodes {
              id
              body
              author {
                login
              }
              createdAt
            }
          }
          reviewThreads(first: 100, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              isResolved
              path
              subjectType
              startLine
              line
              originalStartLine
              originalLine
              isOutdated
              comments(last: 50) {
                pageInfo {
                  hasPreviousPage
                }
                nodes {
                  id
                  body
                  author {
                    login
                  }
                  createdAt
                }
              }
            }
          }
        }
      }
    }
    """

    # Fetch review threads with pagination
    threads = []
    has_next_page = True
    cursor = None
    pr_body = ""
    global_comments = []

    while has_next_page:
        variables = {"owner": owner, "repo": repo, "prNumber": pr_number}
        if cursor:
            variables["cursor"] = cursor

        result = run_graphql(query, variables)
        pull_request = result.get("data", {}).get("repository", {}).get("pullRequest")
        if not pull_request:
            sys.stderr.write(f"Error: Pull Request #{pr_number} not found in repository {owner}/{repo}.\n")
            sys.exit(1)

        # Extract PR body and global comments (only on first page)
        if not cursor:
            pr_body = pull_request.get("body") or ""
            comments_nodes = (pull_request.get("comments") or {}).get("nodes") or []
            for c in comments_nodes:
                body = c.get("body", "") or ""
                author = c.get("author", {}).get("login") if c.get("author") else "ghost"
                global_comments.append({
                    "id": c.get("id"),
                    "author": author,
                    "body": body,
                    "createdAt": c.get("createdAt")
                })

        threads_conn = pull_request.get("reviewThreads") or {}
        threads.extend(threads_conn.get("nodes") or [])

        page_info = threads_conn.get("pageInfo") or {}
        has_next_page = page_info.get("hasNextPage", False)
        cursor = page_info.get("endCursor")

    # --- Print PR Body ---
    print("=== PR Description ===")
    if pr_body:
        print(pr_body)
    else:
        print("(No PR description — the PR author may not have provided one.)")
    print("")

    # --- Print Global Comments ---
    print("=== PR Global Comments ===")
    if global_comments:
        for c in global_comments:
            print(f"  [{c['author']}] ({c['createdAt']}): {c['body']}")
    else:
        print("(No global comments — check the PR page directly for any manual review notes.)")
    print("")

    # --- Print Inline Review Threads ---
    print("=== Inline Review Threads ===")

    # Filter and print threads using shared helpers
    filtered_threads = _filter_threads(threads, args)
    _print_threads(filtered_threads, args)

#endregion

#region Action: Reply

def action_reply(args):
    body = args.body
    if not body.startswith("🤖"):
        body = f"🤖 {body}"

    mutation = """
    mutation($threadId: ID!, $body: String!) {
      addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
        comment {
          id
          body
        }
      }
    }
    """
    try:
        run_graphql(mutation, {"threadId": args.thread_id, "body": body})
        print(f"Successfully replied to thread {args.thread_id}.")
    except Exception as e:
        sys.stderr.write(f"Error: Failed to reply to thread: {e}\n")
        sys.exit(1)

#endregion

#region Action: Resolve & Unresolve

def action_resolve(args):
    owner, repo = get_repo_owner_and_name(args)
    pr_number = args.pr if args.pr is not None else get_pr_number()

    if args.message:
        body = args.message
        if not body.startswith("🤖"):
            body = f"🤖 {body}"

        reply_mutation = """
        mutation($threadId: ID!, $body: String!) {
          addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
            comment {
              id
            }
          }
        }
        """
        try:
            run_graphql(reply_mutation, {"threadId": args.thread_id, "body": body})
            print(f"Successfully replied to thread {args.thread_id}.")
        except Exception as e:
            sys.stderr.write(f"Error: Failed to reply to thread: {e}\n")
            sys.exit(1)

    mutation = """
    mutation($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread {
          id
          isResolved
        }
      }
    }
    """
    try:
        run_graphql(mutation, {"threadId": args.thread_id})
        print(f"Successfully resolved thread {args.thread_id}.")
    except Exception as e:
        sys.stderr.write(f"Error: Failed to resolve thread: {e}\n")
        sys.exit(1)

    # Query remaining unresolved threads with latest comment createdAt
    query = """
    query($owner: String!, $repo: String!, $prNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              comments(last: 1) {
                nodes {
                  createdAt
                }
              }
            }
          }
        }
      }
    }
    """
    result = run_graphql(query, {"owner": owner, "repo": repo, "prNumber": pr_number})
    threads = (result.get("data", {}).get("repository", {}).get("pullRequest", {}).get("reviewThreads", {}).get("nodes") or [])
    unresolved = [t for t in threads if not t.get("isResolved", False)]
    unresolved_count = len(unresolved)

    if unresolved_count == 0:
        print("All threads resolved.")
    else:
        # Find the latest comment createdAt among unresolved threads
        latest_time = None
        for t in unresolved:
            comments_nodes = (t.get("comments") or {}).get("nodes") or []
            if comments_nodes:
                ct = comments_nodes[0].get("createdAt")
                if ct and (latest_time is None or ct > latest_time):
                    latest_time = ct
        if latest_time:
            print(f"{unresolved_count} unresolved thread(s) remaining. Latest activity: {latest_time}")
        else:
            print(f"{unresolved_count} unresolved thread(s) remaining.")

def action_unresolve(args):
    mutation = """
    mutation($threadId: ID!) {
      unresolveReviewThread(input: { threadId: $threadId }) {
        thread {
          id
          isResolved
        }
      }
    }
    """
    try:
        run_graphql(mutation, {"threadId": args.thread_id})
        print(f"Successfully unresolved thread {args.thread_id}.")
    except Exception as e:
        sys.stderr.write(f"Error: Failed to unresolve thread: {e}\n")
        sys.exit(1)

#endregion

#region CLI Entrypoint

def main():
    # Force UTF-8 encoding for standard output and error to avoid encoding crashes on Windows
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8')

    check_gh_installed()
    
    parser = argparse.ArgumentParser(description="Manage GitHub PR review comments using GraphQL API.")
    subparsers = parser.add_subparsers(dest="command", required=True, help="Sub-commands")
    
    # Subcommand: list
    list_parser = subparsers.add_parser("list", help="List review comments for a Pull Request.")
    list_parser.add_argument("--pr", type=int, default=None, help="The Pull Request number. If omitted, will be auto-detected.")
    list_parser.add_argument("--repo", type=str, default=None, help="The GitHub repository in 'owner/repo' format. If omitted, will be auto-detected.")
    list_parser.add_argument("--all", action="store_true", help="List all review comments, including resolved ones.")
    list_parser.add_argument("--path", type=str, default=None, help="Filter comments by file path (substring match).")
    list_parser.add_argument("--author", type=str, default=None, help="Filter comments by author username.")
    
    # Subcommand: reply
    reply_parser = subparsers.add_parser("reply", help="Reply to a specific review comment thread.")
    reply_parser.add_argument("thread_id", type=str, help="The ID of the thread to reply to.")
    reply_parser.add_argument("body", type=str, help="The text of the reply comment.")
    
    # Subcommand: resolve
    resolve_parser = subparsers.add_parser("resolve", help="Mark a review thread as resolved.")
    resolve_parser.add_argument("thread_id", type=str, help="The ID of the thread to resolve.")
    resolve_parser.add_argument("-m", "--message", type=str, default=None, help="Optional message to reply with before resolving.")
    resolve_parser.add_argument("--pr", type=int, default=None, help="The Pull Request number. If omitted, will be auto-detected.")
    resolve_parser.add_argument("--repo", type=str, default=None, help="The GitHub repository in 'owner/repo' format. If omitted, will be auto-detected.")
    
    # Subcommand: unresolve
    unresolve_parser = subparsers.add_parser("unresolve", help="Mark a review thread as unresolved.")
    unresolve_parser.add_argument("thread_id", type=str, help="The ID of the thread to unresolve.")

    # Subcommand: overview
    overview_parser = subparsers.add_parser("overview", help="Show PR description, global comments, and inline review threads in one view.")
    overview_parser.add_argument("--pr", type=int, default=None, help="The Pull Request number. If omitted, will be auto-detected.")
    overview_parser.add_argument("--repo", type=str, default=None, help="The GitHub repository in 'owner/repo' format. If omitted, will be auto-detected.")
    overview_parser.add_argument("--all", action="store_true", help="List all review comments, including resolved ones.")
    overview_parser.add_argument("--path", type=str, default=None, help="Filter comments by file path (substring match).")
    overview_parser.add_argument("--author", type=str, default=None, help="Filter comments by author username.")
    
    args = parser.parse_args()
    
    if args.command == "list":
        action_list(args)
    elif args.command == "reply":
        action_reply(args)
    elif args.command == "resolve":
        action_resolve(args)
    elif args.command == "unresolve":
        action_unresolve(args)
    elif args.command == "overview":
        action_overview(args)

if __name__ == "__main__":
    main()

#endregion
