CREATE TABLE public.social_profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  codeforces_handle text,
  handle_verified_at timestamptz,
  allow_friend_requests boolean NOT NULL DEFAULT true,
  show_cp_presence boolean NOT NULL DEFAULT true,
  show_last_active boolean NOT NULL DEFAULT true,
  notify_friend_requests boolean NOT NULL DEFAULT true,
  notify_new_posts boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT social_profiles_handle_format CHECK (
    codeforces_handle IS NULL OR codeforces_handle ~ '^[A-Za-z0-9_.-]{2,64}$'
  ),
  CONSTRAINT social_profiles_handle_verification CHECK (
    (codeforces_handle IS NULL) = (handle_verified_at IS NULL)
  )
);

CREATE UNIQUE INDEX social_profiles_handle_casefold_idx
  ON public.social_profiles (lower(codeforces_handle))
  WHERE codeforces_handle IS NOT NULL;

CREATE TABLE public.codeforces_link_challenges (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  handle text NOT NULL CHECK (handle ~ '^[A-Za-z0-9_.-]{2,64}$'),
  challenge_hash bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX codeforces_link_challenges_expiry_idx
  ON public.codeforces_link_challenges (expires_at);

CREATE TABLE public.codeforces_credentials (
  user_id uuid PRIMARY KEY REFERENCES public.social_profiles(user_id) ON DELETE CASCADE,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.codeforces_friends_cache (
  user_id uuid NOT NULL REFERENCES public.social_profiles(user_id) ON DELETE CASCADE,
  friend_handle text NOT NULL CHECK (friend_handle ~ '^[A-Za-z0-9_.-]{2,64}$'),
  rating integer,
  last_online_time_seconds bigint,
  is_online boolean NOT NULL DEFAULT false,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, friend_handle)
);

CREATE INDEX codeforces_friends_online_idx
  ON public.codeforces_friends_cache (user_id, is_online, friend_handle);

CREATE TABLE public.friend_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL REFERENCES public.social_profiles(user_id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES public.social_profiles(user_id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (sender_id <> recipient_id)
);

CREATE UNIQUE INDEX friend_requests_pending_pair_idx
  ON public.friend_requests (
    LEAST(sender_id, recipient_id),
    GREATEST(sender_id, recipient_id)
  ) WHERE status = 'pending';
CREATE INDEX friend_requests_recipient_pending_idx
  ON public.friend_requests (recipient_id, created_at DESC) WHERE status = 'pending';
CREATE INDEX friend_requests_sender_idx
  ON public.friend_requests (sender_id, created_at DESC);

CREATE TABLE public.friendships (
  user_low_id uuid NOT NULL REFERENCES public.social_profiles(user_id) ON DELETE CASCADE,
  user_high_id uuid NOT NULL REFERENCES public.social_profiles(user_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_low_id, user_high_id),
  CHECK (user_low_id < user_high_id)
);

CREATE INDEX friendships_high_user_idx ON public.friendships (user_high_id, user_low_id);

CREATE TABLE public.friend_presence (
  user_id uuid PRIMARY KEY REFERENCES public.social_profiles(user_id) ON DELETE CASCADE,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX friend_presence_expiry_idx ON public.friend_presence (expires_at);

CREATE TABLE public.friend_activity_preferences (
  user_id uuid NOT NULL REFERENCES public.social_profiles(user_id) ON DELETE CASCADE,
  friend_id uuid NOT NULL REFERENCES public.social_profiles(user_id) ON DELETE CASCADE,
  notify_online boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, friend_id),
  CHECK (user_id <> friend_id)
);

CREATE TABLE public.blog_watchlist (
  user_id uuid NOT NULL REFERENCES public.social_profiles(user_id) ON DELETE CASCADE,
  handle text NOT NULL CHECK (handle ~ '^[A-Za-z0-9_.-]{2,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, handle)
);

CREATE TABLE public.blog_entries (
  user_id uuid NOT NULL REFERENCES public.social_profiles(user_id) ON DELETE CASCADE,
  entry_id bigint NOT NULL,
  author_handle text NOT NULL,
  title text NOT NULL,
  preview text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  content_preview text NOT NULL DEFAULT '',
  article_text text NOT NULL DEFAULT '',
  detail_fetched_at timestamptz,
  creation_time_seconds bigint NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entry_id)
);

CREATE INDEX blog_entries_user_recent_idx
  ON public.blog_entries (user_id, creation_time_seconds DESC);
CREATE INDEX blog_entries_user_author_idx
  ON public.blog_entries (user_id, lower(author_handle), creation_time_seconds DESC);

CREATE TABLE public.blog_entry_comments (
  user_id uuid NOT NULL,
  entry_id bigint NOT NULL,
  comments jsonb NOT NULL DEFAULT '[]'::jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entry_id),
  FOREIGN KEY (user_id, entry_id)
    REFERENCES public.blog_entries(user_id, entry_id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(comments) = 'array')
);

CREATE TABLE public.blog_entry_state (
  user_id uuid NOT NULL,
  entry_id bigint NOT NULL,
  is_read boolean NOT NULL DEFAULT false,
  is_saved boolean NOT NULL DEFAULT false,
  personal_note text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entry_id),
  FOREIGN KEY (user_id, entry_id)
    REFERENCES public.blog_entries(user_id, entry_id) ON DELETE CASCADE,
  CHECK (length(personal_note) <= 10000)
);

CREATE TABLE public.social_sync_state (
  user_id uuid PRIMARY KEY REFERENCES public.social_profiles(user_id) ON DELETE CASCADE,
  friends_refreshed_at timestamptz,
  blogs_refreshed_at timestamptz,
  next_friends_refresh_at timestamptz,
  next_blogs_refresh_at timestamptz,
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX social_sync_friends_due_idx
  ON public.social_sync_state (next_friends_refresh_at)
  WHERE next_friends_refresh_at IS NOT NULL;
CREATE INDEX social_sync_blogs_due_idx
  ON public.social_sync_state (next_blogs_refresh_at)
  WHERE next_blogs_refresh_at IS NOT NULL;

CREATE TABLE public.social_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.social_profiles(user_id) ON DELETE CASCADE,
  event_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('friend_request', 'new_blog_post', 'friend_activity')),
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  href text,
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, event_key)
);

CREATE INDEX social_notifications_user_recent_idx
  ON public.social_notifications (user_id, created_at DESC);
CREATE INDEX social_notifications_user_unread_idx
  ON public.social_notifications (user_id, created_at DESC) WHERE is_read = false;

CREATE FUNCTION public.are_social_friends_with(other_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.friendships f
    WHERE (f.user_low_id = (SELECT auth.uid()) AND f.user_high_id = other_user)
       OR (f.user_low_id = other_user AND f.user_high_id = (SELECT auth.uid()))
  );
$$;

REVOKE ALL ON FUNCTION public.are_social_friends_with(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.are_social_friends_with(uuid) TO authenticated;

ALTER TABLE public.social_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.codeforces_link_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.codeforces_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.codeforces_friends_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friend_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friend_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friend_activity_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_watchlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_entry_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_entry_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY social_profiles_read_self_or_friends ON public.social_profiles
  FOR SELECT TO authenticated
  USING (
    current_setting('app.cp_coach_backend', true) = 'true'
    AND (
      user_id = (SELECT auth.uid())
      OR public.are_social_friends_with(user_id)
      OR (codeforces_handle IS NOT NULL AND allow_friend_requests)
    )
  );
CREATE POLICY social_profiles_manage_self ON public.social_profiles
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true')
  WITH CHECK (user_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true');

CREATE POLICY codeforces_challenges_manage_self ON public.codeforces_link_challenges
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true')
  WITH CHECK (user_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true');
CREATE POLICY codeforces_credentials_manage_self ON public.codeforces_credentials
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true')
  WITH CHECK (user_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true');
CREATE POLICY codeforces_friends_cache_manage_self ON public.codeforces_friends_cache
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true')
  WITH CHECK (user_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true');

CREATE POLICY friend_requests_read_participant ON public.friend_requests
  FOR SELECT TO authenticated
  USING (
    current_setting('app.cp_coach_backend', true) = 'true'
    AND (sender_id = (SELECT auth.uid()) OR recipient_id = (SELECT auth.uid()))
  );
CREATE POLICY friend_requests_create_sender ON public.friend_requests
  FOR INSERT TO authenticated
  WITH CHECK (sender_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true');
CREATE POLICY friend_requests_update_recipient ON public.friend_requests
  FOR UPDATE TO authenticated
  USING (recipient_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true')
  WITH CHECK (recipient_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true');
CREATE POLICY friend_requests_delete_participant ON public.friend_requests
  FOR DELETE TO authenticated
  USING (
    current_setting('app.cp_coach_backend', true) = 'true'
    AND (sender_id = (SELECT auth.uid()) OR recipient_id = (SELECT auth.uid()))
  );

CREATE FUNCTION public.protect_friend_request_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.sender_id <> OLD.sender_id OR NEW.recipient_id <> OLD.recipient_id THEN
    RAISE EXCEPTION 'Friend request participants cannot be changed';
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('accepted', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid friend request state transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER friend_requests_protect_identity
  BEFORE UPDATE ON public.friend_requests
  FOR EACH ROW EXECUTE FUNCTION public.protect_friend_request_identity();

CREATE POLICY friendships_read_participant ON public.friendships
  FOR SELECT TO authenticated
  USING (
    current_setting('app.cp_coach_backend', true) = 'true'
    AND (user_low_id = (SELECT auth.uid()) OR user_high_id = (SELECT auth.uid()))
  );
CREATE POLICY friendships_accept_request ON public.friendships
  FOR INSERT TO authenticated
  WITH CHECK (
    current_setting('app.cp_coach_backend', true) = 'true'
    AND (
      (user_low_id = (SELECT auth.uid()) OR user_high_id = (SELECT auth.uid()))
    )
    AND EXISTS (
      SELECT 1 FROM public.friend_requests r
      WHERE r.status = 'accepted'
        AND (
          (r.sender_id = user_low_id AND r.recipient_id = user_high_id)
          OR (r.sender_id = user_high_id AND r.recipient_id = user_low_id)
        )
    )
  );
CREATE POLICY friendships_delete_participant ON public.friendships
  FOR DELETE TO authenticated
  USING (
    current_setting('app.cp_coach_backend', true) = 'true'
    AND (user_low_id = (SELECT auth.uid()) OR user_high_id = (SELECT auth.uid()))
  );

CREATE POLICY friend_presence_read_visible_friends ON public.friend_presence
  FOR SELECT TO authenticated
  USING (
    current_setting('app.cp_coach_backend', true) = 'true'
    AND public.are_social_friends_with(user_id)
    AND EXISTS (
      SELECT 1 FROM public.social_profiles p
      WHERE p.user_id = friend_presence.user_id AND p.show_cp_presence
    )
  );
CREATE POLICY friend_presence_manage_self ON public.friend_presence
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true')
  WITH CHECK (user_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true');

CREATE POLICY friend_activity_preferences_manage_self ON public.friend_activity_preferences
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true')
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND current_setting('app.cp_coach_backend', true) = 'true'
    AND public.are_social_friends_with(friend_id)
  );

CREATE POLICY blog_watchlist_manage_self ON public.blog_watchlist
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true')
  WITH CHECK (user_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true');
CREATE POLICY blog_entries_manage_self ON public.blog_entries
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true')
  WITH CHECK (user_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true');
CREATE POLICY blog_entry_comments_manage_self ON public.blog_entry_comments
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true')
  WITH CHECK (user_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true');
CREATE POLICY blog_entry_state_manage_self ON public.blog_entry_state
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true')
  WITH CHECK (user_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true');
CREATE POLICY social_sync_state_manage_self ON public.social_sync_state
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true')
  WITH CHECK (user_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true');
CREATE POLICY social_notifications_manage_self ON public.social_notifications
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true')
  WITH CHECK (user_id = (SELECT auth.uid()) AND current_setting('app.cp_coach_backend', true) = 'true');

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.social_profiles,
  public.codeforces_link_challenges,
  public.codeforces_credentials,
  public.codeforces_friends_cache,
  public.friend_requests,
  public.friendships,
  public.friend_presence,
  public.friend_activity_preferences,
  public.blog_watchlist,
  public.blog_entries,
  public.blog_entry_comments,
  public.blog_entry_state,
  public.social_sync_state,
  public.social_notifications
TO authenticated;
