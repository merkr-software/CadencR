import { useMemo } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  getGetMcpRegistryServerQueryKey,
  getListExtensionClisQueryKey,
  getListInstalledMcpServersQueryKey,
  getListSkillsQueryKey,
  getMcpRegistryServer,
  getSearchMcpRegistryQueryKey,
  listExtensionClis,
  listInstalledMcpServers,
  listSkills,
  searchMcpRegistry,
  type ListSkillsParams,
} from "@/api/generated";
import { toastError } from "@/lib/api-errors";
import { invalidateExtensionInventories } from "@/lib/agent-extensions";

/**
 * Listing runs the agent CLIs (Claude health-checks servers), so it is not
 * re-run eagerly: every change invalidates it, and "Check for updates" forces it.
 */
const INVENTORY_STALE_MS = 5 * 60_000;

export function useExtensionClis() {
  return useQuery({
    queryKey: getListExtensionClisQueryKey(),
    queryFn: ({ signal }) => listExtensionClis(signal),
    staleTime: 5 * 60_000,
  });
}

export function useInstalledMcpServers(enabled = true) {
  return useQuery({
    queryKey: getListInstalledMcpServersQueryKey(),
    queryFn: ({ signal }) => listInstalledMcpServers(undefined, signal),
    staleTime: INVENTORY_STALE_MS,
    enabled,
  });
}

export function useSkillCatalog(params: ListSkillsParams, enabled = true) {
  return useQuery({
    queryKey: getListSkillsQueryKey(params),
    queryFn: ({ signal }) => listSkills(params, signal),
    staleTime: INVENTORY_STALE_MS,
    placeholderData: keepPreviousData,
    enabled,
  });
}

const SKILL_PAGE = 60;

/** The merged skill catalog, one page per offset, for an infinite grid. */
export function useSkillPages(query: string, filter: ListSkillsParams["filter"], enabled = true) {
  return useInfiniteQuery({
    queryKey: [...getListSkillsQueryKey({ q: query, filter }), "pages"],
    queryFn: ({ pageParam, signal }) =>
      listSkills({ q: query, filter, offset: pageParam, limit: SKILL_PAGE }, signal),
    initialPageParam: 0,
    getNextPageParam: (page, pages) => {
      const loaded = pages.reduce((sum, item) => sum + item.skills.length, 0);
      return loaded < page.total ? loaded : undefined;
    },
    staleTime: INVENTORY_STALE_MS,
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** Registry search, one page per cursor; the next page loads when the grid nears its end. */
export function useMcpRegistrySearch(query: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: getSearchMcpRegistryQueryKey({ q: query }),
    queryFn: ({ pageParam, signal }) =>
      searchMcpRegistry({ q: query, cursor: pageParam ?? undefined }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useMcpRegistryServer(name: string, enabled = true) {
  return useQuery({
    queryKey: getGetMcpRegistryServerQueryKey({ name }),
    queryFn: ({ signal }) => getMcpRegistryServer({ name }, signal),
    staleTime: 5 * 60_000,
    retry: false,
    enabled,
  });
}

/** The installed-skills query the Installed view also reads (same key, one request). */
export const INSTALLED_SKILLS_PARAMS: ListSkillsParams = { filter: "installed", limit: 1000 };

/** How many skills and MCP servers the CLIs carry, and how many can update. */
export function useAgentExtensionCounts(enabled = true): { installed: number; updates: number } {
  const mcp = useInstalledMcpServers(enabled);
  const skills = useSkillCatalog(INSTALLED_SKILLS_PARAMS, enabled);
  return useMemo(() => {
    const servers = mcp.data?.listings ?? [];
    const packs = skills.data?.skills ?? [];
    return {
      installed: servers.length + packs.length,
      updates:
        servers.filter((listing) => listing.installations.some((item) => item.update)).length +
        packs.filter((listing) => listing.installed.some((skill) => skill.update)).length,
    };
  }, [mcp.data, skills.data]);
}

/** "Check for updates": every CLI re-reads its marketplaces and servers, then inventories reload. */
export function useRefreshAgentExtensions() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      Promise.all([
        listSkills({ refresh: true, limit: 1 }),
        listInstalledMcpServers({ refresh: true }),
      ]),
    onError: (error) => toastError(error, "The agent CLIs could not refresh their marketplaces."),
    onSettled: () => invalidateExtensionInventories(client),
  });
}
