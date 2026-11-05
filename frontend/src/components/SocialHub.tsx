import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import {
  BookOpen, Check, ExternalLink, Eye, EyeOff, Loader2, LockKeyhole,
  LogOut, MessageSquare, Radio, RefreshCw, Search, ShieldCheck, UserPlus, Users, X,
} from 'lucide-react';
import { getSupabaseAuthClient, isSupabaseAuthConfigured } from '../socialAuthClient';
import {
  socialRequest,
  type BlogEntry,
  type CodeforcesFriend,
  type SocialAccount,
  type SocialFriend,
} from '../socialApi';

type SocialSection = 'friends' | 'blogs' | 'notifications' | 'privacy';
interface FriendRequest {
  id: string;
  direction: 'incoming' | 'outgoing';
  status: string;
  sender_handle: string | null;
  recipient_handle: string | null;
  created_at: string;
}
interface SocialNotification {
  id: string;
  kind: string;
  title: string;
  body: string;
  href: string | null;
  is_read: boolean;
  created_at: string;
}
interface BlogDetail {
  entryId: number;
  title: string;
  authorHandle: string;
  content: string;
  codeforcesUrl: string;
}
interface BlogComment {
  id: number;
  commentatorHandle: string;
  creationTimeSeconds: number;
  text: string;
}
interface LinkChallenge {
  handle: string;
  challenge: string;
  originalFirstName: string | null;
  expiresAt: string;
  instructions: string;
}

const inputClass = 'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none';
const buttonClass = 'inline-flex items-center justify-center gap-2 rounded-lg bg-cyan-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButtonClass = 'inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 transition-colors hover:bg-slate-800 disabled:opacity-50';
const cardClass = 'rounded-xl border border-slate-800 bg-slate-900/80 p-4';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The social request failed.';
}

function timeAgo(value: string | null): string {
  if (!value) return 'Last active hidden';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1_000));
  if (seconds < 60) return 'Active just now';
  if (seconds < 3_600) return `Active ${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `Active ${Math.floor(seconds / 3_600)}h ago`;
  return `Active ${Math.floor(seconds / 86_400)}d ago`;
}

function activeWithinDay(value: string | null): boolean {
  return Boolean(value && Date.now() - new Date(value).getTime() < 24 * 60 * 60_000);
}

function RatingLabel({ rating }: { rating: number | null }) {
  return <span className="text-xs text-slate-400">{rating === null ? 'Unrated' : `Rating ${rating}`}</span>;
}

export const SocialHub: React.FC = () => {
  const [authClient, setAuthClient] = useState<SupabaseClient | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [email, setEmail] = useState('');
  const [emailMessage, setEmailMessage] = useState('');
  const [activeSection, setActiveSection] = useState<SocialSection>('friends');
  const [account, setAccount] = useState<SocialAccount | null>(null);
  const [friends, setFriends] = useState<SocialFriend[]>([]);
  const [codeforcesFriends, setCodeforcesFriends] = useState<CodeforcesFriend[]>([]);
  const [codeforcesRefreshing, setCodeforcesRefreshing] = useState(false);
  const [codeforcesCacheTime, setCodeforcesCacheTime] = useState<string | null>(null);
  const [friendRequests, setFriendRequests] = useState<FriendRequest[]>([]);
  const [bloggers, setBloggers] = useState<string[]>([]);
  const [entries, setEntries] = useState<BlogEntry[]>([]);
  const [blogTopics, setBlogTopics] = useState<string[]>([]);
  const [notifications, setNotifications] = useState<SocialNotification[]>([]);
  const [privacy, setPrivacy] = useState({
    showCpPresence: true,
    showLastActive: true,
    allowFriendRequests: true,
    notifyFriendRequests: true,
    notifyNewPosts: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [handleInput, setHandleInput] = useState('');
  const [challenge, setChallenge] = useState<LinkChallenge | null>(null);
  const [challengeInput, setChallengeInput] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiSecretInput, setApiSecretInput] = useState('');
  const [showCredentials, setShowCredentials] = useState(false);
  const [friendHandleInput, setFriendHandleInput] = useState('');
  const [blogHandleInput, setBlogHandleInput] = useState('');
  const [blogSearch, setBlogSearch] = useState('');
  const [blogTopic, setBlogTopic] = useState('');
  const [blogFilter, setBlogFilter] = useState<'all' | 'unread' | 'saved'>('all');
  const [openEntry, setOpenEntry] = useState<BlogDetail | null>(null);
  const [comments, setComments] = useState<BlogComment[]>([]);
  const [showComments, setShowComments] = useState(false);

  useEffect(() => {
    if (!isSupabaseAuthConfigured()) {
      setAuthReady(true);
      return;
    }
    const client = getSupabaseAuthClient();
    if (!client) {
      setAuthReady(true);
      return;
    }
    setAuthClient(client);
    void client.auth.getSession().then(({ data, error: sessionError }) => {
      if (sessionError) setError('Could not restore the social sign-in session. Please sign in again.');
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: listener } = client.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAccount(null);
      setFriends([]);
      setCodeforcesFriends([]);
      setFriendRequests([]);
      setBloggers([]);
      setEntries([]);
      setNotifications([]);
      setError('');
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  const loadAccount = useCallback(async () => {
    if (!session) return;
    const value = await socialRequest<SocialAccount>(session, '/account');
    setAccount(value);
    setPrivacy({
      showCpPresence: value.profile.show_cp_presence,
      showLastActive: value.profile.show_last_active,
      allowFriendRequests: value.profile.allow_friend_requests,
      notifyFriendRequests: value.profile.notify_friend_requests,
      notifyNewPosts: value.profile.notify_new_posts,
    });
  }, [session]);

  const loadFriends = useCallback(async () => {
    if (!session) return;
    const [friendData, requestData, onlineData] = await Promise.all([
      socialRequest<{ friends: SocialFriend[] }>(session, '/friends'),
      socialRequest<{ requests: FriendRequest[] }>(session, '/friends/requests'),
      socialRequest<{
        connected: boolean;
        friends: CodeforcesFriend[];
        refreshedAt: string | null;
        refreshing: boolean;
      }>(session, '/codeforces/friends/online'),
    ]);
    setFriends(friendData.friends);
    setFriendRequests(requestData.requests);
    setCodeforcesFriends(onlineData.friends);
    setCodeforcesRefreshing(onlineData.refreshing);
    setCodeforcesCacheTime(onlineData.refreshedAt);
  }, [session]);

  const loadBlogs = useCallback(async () => {
    if (!session) return;
    const query = new URLSearchParams();
    if (blogSearch.trim()) query.set('search', blogSearch.trim());
    if (blogTopic.trim()) query.set('topic', blogTopic.trim());
    if (blogFilter === 'unread') query.set('unread', 'true');
    if (blogFilter === 'saved') query.set('saved', 'true');
    const [bloggerData, entryData] = await Promise.all([
      socialRequest<{ bloggers: Array<{ handle: string }> }>(session, '/blogs/watchlist'),
      socialRequest<{ entries: BlogEntry[]; topics: string[] }>(session, `/blogs/entries?${query.toString()}`),
    ]);
    setBloggers(bloggerData.bloggers.map((item) => item.handle));
    setEntries(entryData.entries);
    setBlogTopics(entryData.topics);
  }, [session, blogFilter, blogSearch, blogTopic]);

  const loadNotifications = useCallback(async () => {
    if (!session) return;
    const data = await socialRequest<{ notifications: SocialNotification[] }>(session, '/notifications');
    setNotifications(data.notifications);
  }, [session]);

  const loadBlogsRef = useRef(loadBlogs);
  loadBlogsRef.current = loadBlogs;

  useEffect(() => {
    if (!session) return;
    let active = true;
    setBusy(true);
    setError('');
    const initialLoad = async () => {
      try {
        await loadAccount();
        if (!active) return;
        if (activeSection === 'friends') await loadFriends();
        else if (activeSection === 'notifications') await loadNotifications();
      } catch (loadError) {
        if (active) setError(getErrorMessage(loadError));
      } finally {
        if (active) setBusy(false);
      }
    };
    void initialLoad();
    return () => {
      active = false;
    };
  }, [session, activeSection, loadAccount, loadFriends, loadNotifications]);

  useEffect(() => {
    if (!session || activeSection !== 'friends') return;
    let inFlight = false;
    const refresh = async () => {
      if (document.visibilityState !== 'visible' || inFlight) return;
      inFlight = true;
      try {
        await loadFriends();
      } catch (refreshError) {
        setError(getErrorMessage(refreshError));
      } finally {
        inFlight = false;
      }
    };
    const poll = window.setInterval(() => {
      void refresh();
    }, 60_000);
    const visibilityChanged = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [session, activeSection, loadFriends]);

  useEffect(() => {
    if (!session || !privacy.showCpPresence) return;
    let active = true;
    const heartbeat = async () => {
      try {
        await socialRequest(session, '/presence/heartbeat', {
          method: document.visibilityState === 'visible' ? 'POST' : 'DELETE',
        });
      } catch (heartbeatError) {
        if (active && document.visibilityState === 'visible') setError(getErrorMessage(heartbeatError));
      }
    };
    void heartbeat();
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') void heartbeat();
    }, 60_000);
    const visibilityChanged = () => {
      void heartbeat();
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      active = false;
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', visibilityChanged);
      void socialRequest(session, '/presence/heartbeat', { method: 'DELETE' }).catch(() => {});
    };
  }, [session, privacy.showCpPresence]);

  useEffect(() => {
    if (!session || activeSection !== 'blogs') return;
    const timer = window.setTimeout(() => {
      void loadBlogsRef.current().catch((loadError) => setError(getErrorMessage(loadError)));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [session, activeSection, blogSearch, blogTopic, blogFilter]);

  const topics = useMemo(() => blogTopics, [blogTopics]);

  const runAction = async (action: () => Promise<void>, successMessage?: string) => {
    setBusy(true);
    setError('');
    setEmailMessage('');
    try {
      await action();
      if (successMessage) setEmailMessage(successMessage);
    } catch (actionError) {
      setError(getErrorMessage(actionError));
    } finally {
      setBusy(false);
    }
  };

  const requestMagicLink = () => runAction(async () => {
    if (!authClient || !email.trim()) throw new Error('Enter your email address.');
    const { error: otpError } = await authClient.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    if (otpError) throw otpError;
  }, 'Check your email for a secure sign-in link. Guest training data remains unchanged.');

  const signOut = () => runAction(async () => {
    if (!authClient) return;
    const { error: signOutError } = await authClient.auth.signOut();
    if (signOutError) throw signOutError;
  });

  const startCodeforcesChallenge = () => runAction(async () => {
    if (!session || !handleInput.trim()) throw new Error('Enter a Codeforces handle.');
    const data = await socialRequest<LinkChallenge>(session, '/codeforces/link/challenge', {
      method: 'POST',
      body: JSON.stringify({ handle: handleInput.trim() }),
    });
    setChallenge(data);
    setChallengeInput('');
  });

  const verifyCodeforcesHandle = () => runAction(async () => {
    if (!session || !challenge) return;
    await socialRequest(session, '/codeforces/link/verify', {
      method: 'POST',
      body: JSON.stringify({ challenge: challengeInput.trim() }),
    });
    setChallenge(null);
    setChallengeInput('');
    await loadAccount();
    await loadFriends();
  });

  const saveCodeforcesCredentials = () => runAction(async () => {
    if (!session) return;
    const key = apiKeyInput;
    const secret = apiSecretInput;
    try {
      await socialRequest(session, '/codeforces/credentials', {
        method: 'PUT',
        body: JSON.stringify({ key, secret }),
      });
    } finally {
      setApiKeyInput('');
      setApiSecretInput('');
    }
    await loadAccount();
    await loadFriends();
  });

  const disconnectCodeforces = () => runAction(async () => {
    if (!session) return;
    await socialRequest(session, '/codeforces/link', { method: 'DELETE' });
    setChallenge(null);
    await loadAccount();
    await loadFriends();
  });

  const disconnectCredentials = () => runAction(async () => {
    if (!session) return;
    await socialRequest(session, '/codeforces/credentials', { method: 'DELETE' });
    await loadAccount();
    setCodeforcesFriends([]);
  });

  const sendFriendRequest = () => runAction(async () => {
    if (!session || !friendHandleInput.trim()) throw new Error('Enter the friend’s verified Codeforces handle.');
    await socialRequest(session, '/friends/requests', {
      method: 'POST',
      body: JSON.stringify({ handle: friendHandleInput.trim() }),
    });
    setFriendHandleInput('');
    await loadFriends();
  });

  const respondFriendRequest = (request: FriendRequest, accept: boolean) => runAction(async () => {
    if (!session) return;
    await socialRequest(session, `/friends/requests/${encodeURIComponent(request.id)}/respond`, {
      method: 'POST',
      body: JSON.stringify({ accept }),
    });
    await loadFriends();
  });

  const followBlogger = () => runAction(async () => {
    if (!session || !blogHandleInput.trim()) throw new Error('Enter a Codeforces blogger handle.');
    await socialRequest(session, '/blogs/watchlist', {
      method: 'POST',
      body: JSON.stringify({ handle: blogHandleInput.trim() }),
    });
    setBlogHandleInput('');
    await loadBlogs();
  });

  const unfollowBlogger = (handle: string) => runAction(async () => {
    if (!session) return;
    await socialRequest(session, `/blogs/watchlist/${encodeURIComponent(handle)}`, { method: 'DELETE' });
    await loadBlogs();
  });

  const updateBlogState = (entry: BlogEntry, values: { isRead?: boolean; isSaved?: boolean; note?: string }) => runAction(async () => {
    if (!session) return;
    await socialRequest(session, `/blogs/entries/${entry.entryId}/state`, {
      method: 'PUT',
      body: JSON.stringify(values),
    });
    await loadBlogs();
  });

  const openBlogEntry = (entry: BlogEntry) => runAction(async () => {
    if (!session) return;
    const data = await socialRequest<BlogDetail>(session, `/blogs/entries/${entry.entryId}`);
    setOpenEntry(data);
    setComments([]);
    setShowComments(false);
    if (!entry.is_read) {
      await socialRequest(session, `/blogs/entries/${entry.entryId}/state`, {
        method: 'PUT',
        body: JSON.stringify({ isRead: true }),
      });
      await loadBlogs();
    }
  });

  const loadComments = () => runAction(async () => {
    if (!session || !openEntry) return;
    const data = await socialRequest<{ comments: BlogComment[] }>(
      session,
      `/blogs/entries/${openEntry.entryId}/comments`,
    );
    setComments(data.comments);
    setShowComments(true);
  });

  const savePrivacy = (next: typeof privacy) => runAction(async () => {
    if (!session) return;
    await socialRequest(session, '/presence/settings', {
      method: 'PUT',
      body: JSON.stringify({
        showCpPresence: next.showCpPresence,
        showLastActive: next.showLastActive,
        allowFriendRequests: next.allowFriendRequests,
        notifyFriendRequests: next.notifyFriendRequests,
        notifyNewPosts: next.notifyNewPosts,
      }),
    });
    setPrivacy(next);
  });

  const updateFriendActivity = (friend: SocialFriend, enabled: boolean) => runAction(async () => {
    if (!session) return;
    await socialRequest(session, `/friends/${encodeURIComponent(friend.id)}/activity-notifications`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
    await loadFriends();
  });

  const markNotificationRead = (notification: SocialNotification) => runAction(async () => {
    if (!session) return;
    await socialRequest(session, `/notifications/${encodeURIComponent(notification.id)}/read`, { method: 'PATCH' });
    await loadNotifications();
  });

  if (!isSupabaseAuthConfigured()) {
    return (
      <section className={`${cardClass} mx-auto max-w-xl space-y-3`} aria-labelledby="social-config-title">
        <h2 id="social-config-title" className="flex items-center gap-2 text-base font-semibold text-white">
          <Users className="h-5 w-5 text-cyan-400" /> Friends & Blogs
        </h2>
        <p className="text-sm text-slate-300">Social sign-in is not configured for this deployment. Guest training remains available.</p>
        <p className="text-xs text-slate-500">The deployment owner must configure the public Supabase URL and anon key in the frontend build, and the server-side Auth/database secrets on Render.</p>
      </section>
    );
  }

  if (!authReady) {
    return <div role="status" className={`${cardClass} flex items-center gap-2 text-sm text-slate-300`}><Loader2 className="h-4 w-4 animate-spin" /> Checking social sign-in…</div>;
  }

  if (!session) {
    return (
      <section className={`${cardClass} mx-auto max-w-xl space-y-5`} aria-labelledby="social-signin-title">
        <div>
          <h2 id="social-signin-title" className="flex items-center gap-2 text-base font-semibold text-white">
            <Users className="h-5 w-5 text-cyan-400" /> Friends & Blogs
          </h2>
          <p className="mt-2 text-sm text-slate-400">Sign in to use friends, presence, and blog watchlists across devices. Guest training and browser-local learning data are not changed.</p>
        </div>
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void requestMagicLink(); }}>
          <label className="block space-y-1 text-xs font-medium text-slate-300">
            Email address
            <input className={inputClass} type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </label>
          <button type="submit" className={buttonClass} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LockKeyhole className="h-4 w-4" />}
            Send a sign-in link
          </button>
        </form>
        {emailMessage && <p role="status" className="text-sm text-emerald-300">{emailMessage}</p>}
        {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
        <p className="text-xs text-slate-500">No Codeforces password is requested. Supabase sends a one-time email link.</p>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold text-white"><Users className="h-5 w-5 text-cyan-400" /> Friends & Blogs</h2>
          <p className="mt-1 text-xs text-slate-500">Signed in · {session.user.email || 'Supabase account'}</p>
        </div>
        <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => void signOut()}>
          <LogOut className="h-3.5 w-3.5" /> Sign out
        </button>
      </header>

      <nav aria-label="Friends and blogs sections" className="flex gap-1 overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/60 p-1">
        {([
          ['friends', 'Friends'],
          ['blogs', 'Blogs'],
          ['notifications', 'Notifications'],
          ['privacy', 'Privacy'],
        ] as Array<[SocialSection, string]>).map(([section, label]) => (
          <button key={section} type="button" onClick={() => setActiveSection(section)}
            aria-current={activeSection === section ? 'page' : undefined}
            className={`shrink-0 rounded-lg px-3 py-2 text-xs font-semibold ${activeSection === section ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
            {label}
          </button>
        ))}
      </nav>

      {busy && <p role="status" className="flex items-center gap-2 text-xs text-slate-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Updating social data…</p>}
      {error && <div role="alert" className="rounded-lg border border-rose-900/60 bg-rose-950/30 p-3 text-xs text-rose-200">{error}</div>}

      {activeSection === 'friends' && (
        <section className="space-y-5" aria-labelledby="friends-section-title">
          <h3 id="friends-section-title" className="sr-only">Friends activity</h3>
          <div className={`${cardClass} space-y-3`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-white"><ShieldCheck className="h-4 w-4 text-cyan-400" /> Codeforces Friends</h3>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-slate-500">Codeforces Online is separate from CP Coach Online.</span>
                <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => void runAction(loadFriends)} aria-label="Refresh friends status">
                  <RefreshCw className="h-3.5 w-3.5" /> Refresh
                </button>
              </div>
            </div>
            {codeforcesCacheTime && <p className="text-[11px] text-slate-500">Cached friend status refreshed {new Date(codeforcesCacheTime).toLocaleString()}{codeforcesRefreshing ? ' · a background refresh is queued' : ''}.</p>}
            {!account?.profile.codeforces_handle ? (
              <p className="text-sm text-slate-400">Link and verify your Codeforces handle in the account setup below to enable friend activity.</p>
            ) : !account.credentialsConfigured ? (
              <p className="text-sm text-slate-400">Your handle is verified. Add an API Key and Secret in account setup to request the official online-friends list.</p>
            ) : codeforcesFriends.length === 0 ? (
              <p className="text-sm text-slate-400">{codeforcesRefreshing ? 'Waiting for the first official Codeforces friend refresh…' : 'No Codeforces friends in the latest verified refresh. The list is not populated with sample data.'}</p>
            ) : (
              <ul className="divide-y divide-slate-800">
                {codeforcesFriends.map((friend) => (
                  <li key={friend.handle} className="flex flex-wrap items-center justify-between gap-2 py-3">
                    <a className="font-medium text-cyan-300 hover:text-cyan-200" href={friend.profileUrl} target="_blank" rel="noreferrer">{friend.handle}</a>
                    <span className={`inline-flex items-center gap-1.5 text-xs ${friend.codeforcesOnline ? 'text-emerald-300' : 'text-slate-400'}`}><span className={`h-2 w-2 rounded-full ${friend.codeforcesOnline ? 'bg-emerald-400' : 'bg-slate-500'}`} /> {friend.codeforcesOnline ? 'Online on Codeforces' : friend.lastOnlineTimeSeconds && Date.now() / 1_000 - friend.lastOnlineTimeSeconds < 86_400 ? 'Recently active on Codeforces' : 'Offline on Codeforces'}</span>
                    <RatingLabel rating={friend.rating} />
                    <span className="text-xs text-slate-500">{friend.lastOnlineTimeSeconds ? timeAgo(new Date(friend.lastOnlineTimeSeconds * 1_000).toISOString()) : 'Last-known activity unavailable'}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className={`${cardClass} space-y-3`}>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white"><Radio className="h-4 w-4 text-violet-400" /> CP Coach Friends</h3>
            <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); void sendFriendRequest(); }}>
              <input className={inputClass} value={friendHandleInput} onChange={(event) => setFriendHandleInput(event.target.value)} placeholder="Verified Codeforces handle" aria-label="Friend's Codeforces handle" />
              <button type="submit" className={buttonClass} disabled={busy}><UserPlus className="h-4 w-4" /> Send request</button>
            </form>
            <p className="text-xs text-slate-500">Only members who verified this handle and allow friend requests can be found.</p>
            {friendRequests.map((request) => (
              <div key={request.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                <p className="text-sm text-slate-300">{request.direction === 'incoming' ? request.sender_handle : request.recipient_handle} · {request.direction} request</p>
                {request.direction === 'incoming' && (
                  <span className="flex gap-2">
                    <button className={buttonClass} type="button" disabled={busy} onClick={() => void respondFriendRequest(request, true)}><Check className="h-3.5 w-3.5" /> Accept</button>
                    <button className={secondaryButtonClass} type="button" disabled={busy} onClick={() => void respondFriendRequest(request, false)}><X className="h-3.5 w-3.5" /> Reject</button>
                  </span>
                )}
              </div>
            ))}
            {friends.length === 0 ? (
              <p className="text-sm text-slate-500">No accepted CP Coach friends yet.</p>
            ) : (
              <ul className="divide-y divide-slate-800">
                {friends.map((friend) => (
                  <li key={friend.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="font-medium text-white">{friend.handle || 'Codeforces account disconnected'}</p>
                      <p className="mt-1 text-xs text-slate-500">{friend.cpCoachOnline ? 'Online on CP Coach' : activeWithinDay(friend.lastActiveAt) ? timeAgo(friend.lastActiveAt) : 'Offline'}</p>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-slate-400">
                      <input type="checkbox" checked={friend.notifyOnOnline} disabled={busy} onChange={(event) => void updateFriendActivity(friend, event.target.checked)} />
                      Notify when online
                    </label>
                    <span className={`rounded-full px-2 py-1 text-[10px] ${friend.cpCoachOnline ? 'bg-emerald-950 text-emerald-300' : activeWithinDay(friend.lastActiveAt) ? 'bg-amber-950 text-amber-300' : 'bg-slate-800 text-slate-400'}`}>
                      {friend.cpCoachOnline ? 'Online' : activeWithinDay(friend.lastActiveAt) ? 'Recently active' : 'Offline'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <CodeforcesLinkPanel
            session={session}
            account={account}
            busy={busy}
            handleInput={handleInput}
            setHandleInput={setHandleInput}
            challenge={challenge}
            challengeInput={challengeInput}
            setChallengeInput={setChallengeInput}
            apiKeyInput={apiKeyInput}
            setApiKeyInput={setApiKeyInput}
            apiSecretInput={apiSecretInput}
            setApiSecretInput={setApiSecretInput}
            showCredentials={showCredentials}
            setShowCredentials={setShowCredentials}
            onStartChallenge={startCodeforcesChallenge}
            onVerify={verifyCodeforcesHandle}
            onSaveCredentials={saveCodeforcesCredentials}
            onDisconnectCredentials={disconnectCredentials}
            onDisconnectCodeforces={disconnectCodeforces}
          />
        </section>
      )}

      {activeSection === 'blogs' && (
        <section className="space-y-4" aria-labelledby="blogs-section-title">
          <div className={`${cardClass} space-y-3`}>
            <h3 id="blogs-section-title" className="flex items-center gap-2 text-sm font-semibold text-white"><BookOpen className="h-4 w-4 text-cyan-400" /> Codeforces Blog Watchlist</h3>
            <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); void followBlogger(); }}>
              <input className={inputClass} value={blogHandleInput} onChange={(event) => setBlogHandleInput(event.target.value)} placeholder="Codeforces blogger handle" aria-label="Codeforces blogger handle" />
              <button type="submit" className={buttonClass} disabled={busy}><UserPlus className="h-4 w-4" /> Follow</button>
            </form>
            <div className="flex flex-wrap gap-2">
              {bloggers.map((handle) => <span key={handle} className="inline-flex items-center gap-1 rounded-full bg-slate-800 px-2.5 py-1 text-xs text-slate-300">{handle}<button type="button" aria-label={`Unfollow ${handle}`} onClick={() => void unfollowBlogger(handle)} className="ml-1 text-slate-500 hover:text-rose-300"><X className="h-3 w-3" /></button></span>)}
              {bloggers.length === 0 && <span className="text-xs text-slate-500">Follow a handle to populate recent posts.</span>}
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
            <label className="relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
              <input className={`${inputClass} pl-9`} value={blogSearch} onChange={(event) => setBlogSearch(event.target.value)} placeholder="Search post titles and previews" aria-label="Search blog posts" />
            </label>
            <select className={inputClass} value={blogFilter} onChange={(event) => setBlogFilter(event.target.value as typeof blogFilter)} aria-label="Filter blog posts">
              <option value="all">Latest posts</option><option value="unread">Unread posts</option><option value="saved">Saved articles</option>
            </select>
            <select className={inputClass} value={blogTopic} onChange={(event) => setBlogTopic(event.target.value)} aria-label="Filter blog topic">
              <option value="">All actual tags</option>{topics.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
            </select>
          </div>
          {entries.length === 0 ? <p className={`${cardClass} text-sm text-slate-500`}>No posts match these filters. Blog synchronization runs in the background.</p> : (
            <ul className="space-y-3">
              {entries.map((entry) => (
                <li key={entry.entryId} className={`${cardClass} space-y-3`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <button type="button" className="text-left text-sm font-semibold text-white hover:text-cyan-300" onClick={() => void openBlogEntry(entry)}>{entry.title}</button>
                      <p className="mt-1 text-xs text-slate-500">{entry.author_handle} · {new Date(entry.creationTimeSeconds * 1_000).toLocaleDateString()}</p>
                    </div>
                    <div className="flex gap-1.5">
                      <button type="button" className={secondaryButtonClass} aria-label={entry.is_read ? 'Mark unread' : 'Mark read'} onClick={() => void updateBlogState(entry, { isRead: !entry.is_read })}><Eye className="h-3.5 w-3.5" />{entry.is_read ? 'Read' : 'Unread'}</button>
                      <button type="button" className={secondaryButtonClass} onClick={() => void updateBlogState(entry, { isSaved: !entry.is_saved })}>{entry.is_saved ? 'Saved' : 'Save'}</button>
                      <a className={secondaryButtonClass} href={entry.codeforcesUrl} target="_blank" rel="noreferrer" aria-label="Open original Codeforces article"><ExternalLink className="h-3.5 w-3.5" /></a>
                    </div>
                  </div>
                  {entry.preview && <p className="whitespace-pre-line text-sm text-slate-300">{entry.preview}</p>}
                  {entry.tags.length > 0 && <div className="flex flex-wrap gap-1.5">{entry.tags.map((tag) => <span key={tag} className="rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">{tag}</span>)}</div>}
                  <label className="block space-y-1 text-xs text-slate-400">Personal note
                    <textarea className={`${inputClass} min-h-16`} maxLength={10_000} value={entry.personal_note} onChange={(event) => {
                      const note = event.target.value;
                      setEntries((current) => current.map((item) => item.entryId === entry.entryId ? { ...item, personal_note: note } : item));
                    }} onBlur={(event) => void updateBlogState(entry, { note: event.target.value })} placeholder="Private note…" />
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {activeSection === 'notifications' && (
        <section className="space-y-3" aria-labelledby="social-notifications-title">
          <h3 id="social-notifications-title" className="text-sm font-semibold text-white">In-app notifications</h3>
          {notifications.length === 0 ? <p className={`${cardClass} text-sm text-slate-500`}>No new social notifications.</p> : notifications.map((notification) => (
            <article key={notification.id} className={`${cardClass} flex items-start justify-between gap-3`}>
              <div>
                <p className={`text-sm ${notification.is_read ? 'text-slate-400' : 'font-semibold text-white'}`}>{notification.title}</p>
                <p className="mt-1 text-xs text-slate-400">{notification.body}</p>
                <p className="mt-2 text-[10px] text-slate-600">{new Date(notification.created_at).toLocaleString()}</p>
              </div>
              {!notification.is_read && <button className={secondaryButtonClass} type="button" onClick={() => void markNotificationRead(notification)}>Mark read</button>}
              {notification.href && <a className="text-cyan-300" href={notification.href} target={notification.href.startsWith('http') ? '_blank' : undefined} rel="noreferrer" aria-label="Open notification"><ExternalLink className="h-4 w-4" /></a>}
            </article>
          ))}
          <p className="text-xs text-slate-500">These notifications are stored in Supabase. Browser push is not enabled until VAPID and durable notification storage are configured and tested.</p>
        </section>
      )}

      {activeSection === 'privacy' && (
        <section className={`${cardClass} space-y-4`} aria-labelledby="social-privacy-title">
          <h3 id="social-privacy-title" className="text-sm font-semibold text-white">Privacy and notification controls</h3>
          {([
            ['showCpPresence', 'Show Online on CP Coach to accepted friends'],
            ['showLastActive', 'Share last-active time with accepted friends'],
            ['allowFriendRequests', 'Allow friend requests by verified Codeforces handle'],
            ['notifyFriendRequests', 'Notify me about friend requests'],
            ['notifyNewPosts', 'Notify me about new posts from followed bloggers'],
          ] as Array<[keyof typeof privacy, string]>).map(([key, label]) => (
            <label key={key} className="flex items-center justify-between gap-3 border-b border-slate-800 pb-3 text-sm text-slate-300">
              <span>{label}</span>
              <input type="checkbox" checked={privacy[key]} disabled={busy} onChange={(event) => void savePrivacy({ ...privacy, [key]: event.target.checked })} />
            </label>
          ))}
          <p className="text-xs text-slate-500">Presence expires after two minutes without a visible-page heartbeat. Hiding CP Coach presence removes the current heartbeat immediately.</p>
        </section>
      )}

      {openEntry && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="blog-detail-title">
          <section className="flex max-h-[92vh] w-full max-w-3xl flex-col rounded-t-2xl border border-slate-700 bg-[#0c0f1a] p-4 sm:rounded-2xl sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div><h2 id="blog-detail-title" className="text-base font-bold text-white">{openEntry.title}</h2><p className="mt-1 text-xs text-slate-500">{openEntry.authorHandle}</p></div>
              <button className={secondaryButtonClass} type="button" onClick={() => setOpenEntry(null)} aria-label="Close article preview"><X className="h-4 w-4" /></button>
            </div>
            <div className="mt-4 overflow-y-auto whitespace-pre-wrap text-sm leading-6 text-slate-300">{openEntry.content}</div>
            <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-800 pt-3">
              <a className={secondaryButtonClass} href={openEntry.codeforcesUrl} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" /> Original Codeforces article</a>
              <button className={secondaryButtonClass} type="button" disabled={busy} onClick={() => void loadComments()}><MessageSquare className="h-3.5 w-3.5" /> Load comments</button>
            </div>
            {showComments && <div className="mt-3 max-h-48 space-y-2 overflow-y-auto border-t border-slate-800 pt-3">{comments.map((comment) => <div key={comment.id} className="rounded-lg bg-slate-900 p-2"><p className="text-xs font-medium text-cyan-300">{comment.commentatorHandle}</p><p className="mt-1 whitespace-pre-wrap text-xs text-slate-300">{comment.text}</p></div>)}</div>}
          </section>
        </div>
      )}
    </div>
  );
};

interface CodeforcesLinkPanelProps {
  session: Session;
  account: SocialAccount | null;
  busy: boolean;
  handleInput: string;
  setHandleInput: (value: string) => void;
  challenge: LinkChallenge | null;
  challengeInput: string;
  setChallengeInput: (value: string) => void;
  apiKeyInput: string;
  setApiKeyInput: (value: string) => void;
  apiSecretInput: string;
  setApiSecretInput: (value: string) => void;
  showCredentials: boolean;
  setShowCredentials: (value: boolean) => void;
  onStartChallenge: () => void;
  onVerify: () => void;
  onSaveCredentials: () => void;
  onDisconnectCredentials: () => void;
  onDisconnectCodeforces: () => void;
}

const CodeforcesLinkPanel: React.FC<CodeforcesLinkPanelProps> = ({
  account, busy, handleInput, setHandleInput, challenge, challengeInput, setChallengeInput,
  apiKeyInput, setApiKeyInput, apiSecretInput, setApiSecretInput, showCredentials,
  setShowCredentials, onStartChallenge, onVerify, onSaveCredentials,
  onDisconnectCredentials, onDisconnectCodeforces,
}) => (
  <section className={`${cardClass} space-y-4`} aria-labelledby="cf-link-title">
    <h3 id="cf-link-title" className="flex items-center gap-2 text-sm font-semibold text-white"><ShieldCheck className="h-4 w-4 text-cyan-400" /> Codeforces account authorization</h3>
    {account?.profile.codeforces_handle ? (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-300">Verified handle: <a className="text-cyan-300" href={`https://codeforces.com/profile/${encodeURIComponent(account.profile.codeforces_handle)}`} target="_blank" rel="noreferrer">{account.profile.codeforces_handle}</a></p>
        <button type="button" className={secondaryButtonClass} disabled={busy} onClick={onDisconnectCodeforces}>Disconnect handle and credentials</button>
      </div>
    ) : (
      <div className="space-y-2">
        <p className="text-xs text-slate-400">Handle linking uses a short-lived first-name challenge read back through the official `user.info` API. CP Coach never requests your Codeforces password or edits your profile.</p>
        <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); onStartChallenge(); }}>
          <input className={inputClass} value={handleInput} onChange={(event) => setHandleInput(event.target.value)} placeholder="Your Codeforces handle" aria-label="Your Codeforces handle" />
          <button type="submit" className={buttonClass} disabled={busy}>Start verification</button>
        </form>
      </div>
    )}
    {challenge && (
      <div className="space-y-3 rounded-lg border border-amber-900/50 bg-amber-950/20 p-3">
        <p className="text-xs text-amber-200">{challenge.instructions}</p>
        {challenge.originalFirstName && <p className="text-xs text-slate-400">Remember your current first name so you can restore it after verification.</p>}
        <code className="block break-all rounded bg-slate-950 p-2 text-sm text-cyan-200">{challenge.challenge}</code>
        <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); onVerify(); }}>
          <input className={inputClass} value={challengeInput} onChange={(event) => setChallengeInput(event.target.value)} placeholder="Paste the challenge" aria-label="Codeforces ownership challenge" />
          <button type="submit" className={buttonClass} disabled={busy}>Verify handle</button>
        </form>
        <p className="text-[11px] text-slate-500">Expires {new Date(challenge.expiresAt).toLocaleTimeString()}.</p>
      </div>
    )}
    {account?.profile.codeforces_handle && (
      <div className="space-y-3 border-t border-slate-800 pt-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-slate-400">Signed requests are generated only on CP Coach's backend. Credentials are encrypted before storage and are never returned.</p>
          <button type="button" className={secondaryButtonClass} aria-expanded={showCredentials} onClick={() => setShowCredentials(!showCredentials)}>{showCredentials ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />} API setup</button>
        </div>
        {account.credentialsConfigured && <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-emerald-300">Codeforces API authorization is connected.</p><button type="button" className={secondaryButtonClass} disabled={busy} onClick={onDisconnectCredentials}>Disconnect authorization</button></div>}
        {showCredentials && (
          <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); onSaveCredentials(); }}>
            <label className="block space-y-1 text-xs text-slate-400">API Key
              <input className={inputClass} type="password" autoComplete="off" value={apiKeyInput} onChange={(event) => setApiKeyInput(event.target.value)} />
            </label>
            <label className="block space-y-1 text-xs text-slate-400">API Secret
              <input className={inputClass} type="password" autoComplete="new-password" value={apiSecretInput} onChange={(event) => setApiSecretInput(event.target.value)} />
            </label>
            <button type="submit" className={buttonClass} disabled={busy || !apiKeyInput || !apiSecretInput}>Test and save encrypted credentials</button>
            <p className="text-[11px] text-slate-500">Create these in Codeforces → Settings → API for your verified handle. The API test confirms the key works; Codeforces does not reveal the key owner through this method. Never enter your Codeforces password.</p>
          </form>
        )}
      </div>
    )}
    <p className="text-[11px] text-slate-600">Last-active information and Codeforces Online are sourced only from verified official API data.</p>
  </section>
);
