/**
 * A scripted double for one channel's YouTube Data API v3 surface: OAuth2 token/refresh/revoke,
 * paginated `playlistItems.list` / `commentThreads.list`, `search.list`, a `comments.insert`-style
 * reply endpoint, and `channels.list` for discovery/health. State (videos, comments, and — most
 * importantly — the search/insert call counters) lives in the closure so several `ConnCtx`s built
 * from the SAME double instance see the SAME data and the SAME counters (the contract suite's
 * cursor-resume test relies on the former; the search-refusal tests rely on the latter).
 */
import { jsonResponse } from '@nexus/connector-sdk/testing';
import type { FetchLike } from '@nexus/connector-sdk';

export type YoutubeDoubleVideo = {
  id: string;
  snippet: {
    publishedAt: string;
    channelId: string;
    title: string;
    description: string;
    resourceId: { videoId: string };
  };
  contentDetails: { videoId: string; videoPublishedAt: string };
};

export type YoutubeDoubleCommentThread = {
  id: string;
  snippet: {
    channelId: string;
    videoId: string;
    canReply: boolean;
    totalReplyCount: number;
    isPublic: boolean;
    topLevelComment: {
      id: string;
      snippet: {
        authorDisplayName: string;
        authorProfileImageUrl: string;
        authorChannelId: { value: string };
        videoId: string;
        textDisplay: string;
        textOriginal: string;
        likeCount: number;
        publishedAt: string;
      };
    };
  };
};

function headerLookup(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export function videoFixture(
  i: number,
  channelId: string,
  overrides: Partial<YoutubeDoubleVideo['snippet']> = {},
): YoutubeDoubleVideo {
  const publishedAt = new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString();
  return {
    id: `pli_${i}`,
    snippet: {
      publishedAt,
      channelId,
      title: `Video ${i}`,
      description: `Description for video ${i}`,
      resourceId: { videoId: `vid_${i}` },
      ...overrides,
    },
    contentDetails: { videoId: `vid_${i}`, videoPublishedAt: publishedAt },
  };
}

export function commentThreadFixture(
  i: number,
  channelId: string,
  videoId = 'vid_0',
): YoutubeDoubleCommentThread {
  return {
    id: `thread_${i}`,
    snippet: {
      channelId,
      videoId,
      canReply: true,
      totalReplyCount: 0,
      isPublic: true,
      topLevelComment: {
        id: `thread_${i}`,
        snippet: {
          authorDisplayName: `Commenter ${i}`,
          authorProfileImageUrl: `https://example.invalid/avatar/${i}.png`,
          authorChannelId: { value: `UCviewer${i}` },
          videoId,
          textDisplay: `Great video! (${i})`,
          textOriginal: `Great video! (${i})`,
          likeCount: i,
          publishedAt: new Date(Date.UTC(2026, 8, 2, 0, i)).toISOString(),
        },
      },
    },
  };
}

function paginate<T>(items: T[], pageToken: string | undefined, pageSize: number) {
  const offset = pageToken ? Number(pageToken) : 0;
  const slice = items.slice(offset, offset + pageSize);
  const next = offset + pageSize < items.length ? String(offset + pageSize) : undefined;
  return { items: slice, nextPageToken: next };
}

export function createYoutubeDouble(
  opts: {
    channelId?: string;
    totalVideos?: number;
    totalComments?: number;
    pageSize?: number;
    forceStatus?: 401 | 429;
    videos?: YoutubeDoubleVideo[];
    comments?: YoutubeDoubleCommentThread[];
  } = {},
): {
  fetch: FetchLike;
  channelId: string;
  uploadsPlaylistId: string;
  videos: YoutubeDoubleVideo[];
  comments: YoutubeDoubleCommentThread[];
  searchCallCount: () => number;
  insertCallCount: () => number;
} {
  const channelId = opts.channelId ?? 'UCchannel0000000000000000';
  const uploadsPlaylistId = `UU${channelId.slice(2)}`;
  const pageSize = opts.pageSize ?? 3;
  const videos =
    opts.videos ??
    Array.from({ length: opts.totalVideos ?? 7 }, (_, i) => videoFixture(i, channelId));
  const comments =
    opts.comments ??
    Array.from({ length: opts.totalComments ?? 7 }, (_, i) => commentThreadFixture(i, channelId));

  let searchCalls = 0;
  let insertCalls = 0;

  const fetch: FetchLike = async (rawUrl, init) => {
    if (opts.forceStatus === 429)
      return jsonResponse(
        429,
        { error: { code: 429, message: 'rate limited' } },
        { 'retry-after': '1' },
      );
    if (opts.forceStatus === 401)
      return jsonResponse(401, { error: { code: 401, message: 'invalid credentials' } });

    const authz = headerLookup(init.headers, 'authorization');
    if (!authz?.startsWith('Bearer '))
      return jsonResponse(401, { error: { code: 401, message: 'missing bearer token' } });

    const u = new URL(rawUrl);

    if (u.pathname.endsWith('/youtube/v3/channels')) {
      return jsonResponse(200, {
        items: [
          {
            id: channelId,
            snippet: { title: 'My Channel', customUrl: '@mychannel' },
            contentDetails: { relatedPlaylists: { uploads: uploadsPlaylistId } },
          },
        ],
      });
    }

    if (u.pathname.endsWith('/youtube/v3/playlistItems')) {
      const requestedPlaylist = u.searchParams.get('playlistId');
      if (requestedPlaylist !== uploadsPlaylistId) return jsonResponse(200, { items: [] });
      const pageToken = u.searchParams.get('pageToken') ?? undefined;
      const page = paginate(videos, pageToken, pageSize);
      return jsonResponse(200, page, {
        'x-quota-cost': '1',
      });
    }

    if (u.pathname.endsWith('/youtube/v3/commentThreads')) {
      const pageToken = u.searchParams.get('pageToken') ?? undefined;
      const page = paginate(comments, pageToken, pageSize);
      return jsonResponse(200, page);
    }

    if (u.pathname.endsWith('/youtube/v3/search')) {
      searchCalls += 1;
      const pageToken = u.searchParams.get('pageToken') ?? undefined;
      const results = videos.map((v) => ({
        id: { videoId: v.contentDetails.videoId },
        snippet: {
          title: v.snippet.title,
          channelId: v.snippet.channelId,
          publishedAt: v.snippet.publishedAt,
        },
      }));
      const page = paginate(results, pageToken, pageSize);
      return jsonResponse(200, page);
    }

    if (u.pathname.endsWith('/youtube/v3/comments') && init.method === 'POST') {
      insertCalls += 1;
      const bodyText = typeof init.body === 'string' ? init.body : '';
      const body = bodyText
        ? (JSON.parse(bodyText) as { snippet?: { textOriginal?: string } })
        : {};
      return jsonResponse(201, {
        id: `comment_${insertCalls}`,
        snippet: {
          textOriginal: body.snippet?.textOriginal ?? '',
          publishedAt: new Date().toISOString(),
        },
      });
    }

    return jsonResponse(404, { error: { code: 404, message: 'not_found' } });
  };

  return {
    fetch,
    channelId,
    uploadsPlaylistId,
    videos,
    comments,
    searchCallCount: () => searchCalls,
    insertCallCount: () => insertCalls,
  };
}
