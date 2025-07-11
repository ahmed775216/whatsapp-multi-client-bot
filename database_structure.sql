--
-- PostgreSQL database dump
--

-- Dumped from database version 15.13
-- Dumped by pg_dump version 15.13

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: cleanup_old_sync_logs(integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.cleanup_old_sync_logs(days_to_keep integer DEFAULT 30) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM api_sync_log 
    WHERE started_at < CURRENT_TIMESTAMP - (days_to_keep * INTERVAL '1 day'); -- Corrected interval usage
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;


ALTER FUNCTION public.cleanup_old_sync_logs(days_to_keep integer) OWNER TO postgres;

--
-- Name: get_bot_instance_id(character varying); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.get_bot_instance_id(p_client_id character varying) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_instance_id INTEGER;
BEGIN
    SELECT id INTO v_instance_id FROM bot_instances WHERE client_id = p_client_id LIMIT 1;
    RETURN v_instance_id;
END;
$$;


ALTER FUNCTION public.get_bot_instance_id(p_client_id character varying) OWNER TO postgres;

--
-- Name: is_whitelisted(integer, character varying); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.is_whitelisted(p_bot_instance_id integer, p_jid character varying) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN EXISTS(
        SELECT 1 FROM whitelisted_users wu
        WHERE wu.bot_instance_id = p_bot_instance_id AND wu.user_jid = p_jid AND wu.api_active = true
    ) OR EXISTS (
        SELECT 1 FROM whitelisted_groups wg
        WHERE wg.bot_instance_id = p_bot_instance_id AND wg.group_jid = p_jid AND wg.is_active = true
    );
END;
$$;


ALTER FUNCTION public.is_whitelisted(p_bot_instance_id integer, p_jid character varying) OWNER TO postgres;

--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
   NEW.updated_at = NOW(); 
   RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_updated_at_column() OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: api_sync_log; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.api_sync_log (
    id integer NOT NULL,
    bot_instance_id integer NOT NULL,
    sync_type character varying(50) NOT NULL,
    sync_status character varying(50) NOT NULL,
    contacts_fetched integer,
    contacts_added integer,
    contacts_updated integer,
    contacts_removed integer,
    error_message text,
    started_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    completed_at timestamp with time zone
);


ALTER TABLE public.api_sync_log OWNER TO postgres;

--
-- Name: TABLE api_sync_log; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.api_sync_log IS 'Tracks the status and results of synchronizations with external APIs.';


--
-- Name: api_sync_log_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.api_sync_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.api_sync_log_id_seq OWNER TO postgres;

--
-- Name: api_sync_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.api_sync_log_id_seq OWNED BY public.api_sync_log.id;


--
-- Name: asked_lids_cache; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.asked_lids_cache (
    id integer NOT NULL,
    bot_instance_id integer NOT NULL,
    lid_jid character varying(100) NOT NULL,
    asked_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.asked_lids_cache OWNER TO postgres;

--
-- Name: TABLE asked_lids_cache; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.asked_lids_cache IS 'Tracks when a LID was last asked for identification to manage cooldowns.';


--
-- Name: asked_lids_cache_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.asked_lids_cache_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.asked_lids_cache_id_seq OWNER TO postgres;

--
-- Name: asked_lids_cache_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.asked_lids_cache_id_seq OWNED BY public.asked_lids_cache.id;


--
-- Name: bot_contacts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.bot_contacts (
    id integer NOT NULL,
    bot_instance_id integer NOT NULL,
    user_jid character varying(100) NOT NULL,
    phone_number character varying(30),
    display_name character varying(255),
    whatsapp_name character varying(255),
    is_whatsapp_contact boolean DEFAULT true,
    is_saved_contact boolean DEFAULT true,
    synced_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.bot_contacts OWNER TO postgres;

--
-- Name: TABLE bot_contacts; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.bot_contacts IS 'Stores contacts fetched from WhatsApp for each bot instance.';


--
-- Name: bot_contacts_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.bot_contacts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.bot_contacts_id_seq OWNER TO postgres;

--
-- Name: bot_contacts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.bot_contacts_id_seq OWNED BY public.bot_contacts.id;


--
-- Name: bot_instances; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.bot_instances (
    id integer NOT NULL,
    client_id character varying(100) NOT NULL,
    phone_number character varying(30),
    display_name character varying(255),
    status character varying(50) DEFAULT 'disconnected'::character varying,
    api_username character varying(100),
    api_password_encrypted text,
    owner_number character varying(30),
    linked_at timestamp with time zone,
    last_seen timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.bot_instances OWNER TO postgres;

--
-- Name: TABLE bot_instances; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.bot_instances IS 'Stores information about each managed WhatsApp bot instance.';


--
-- Name: COLUMN bot_instances.client_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.bot_instances.client_id IS 'Unique identifier for the client instance (e.g., client_PHONE_NUMBER or client_new_linking_XYZ).';


--
-- Name: COLUMN bot_instances.phone_number; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.bot_instances.phone_number IS 'The actual WhatsApp number associated with this instance (e.g., 967xxxxxxxxx).';


--
-- Name: COLUMN bot_instances.display_name; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.bot_instances.display_name IS 'User-friendly alias or name for the instance.';


--
-- Name: COLUMN bot_instances.status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.bot_instances.status IS 'Current operational status of the bot instance (e.g., connected, disconnected, linking_qr).';


--
-- Name: COLUMN bot_instances.api_password_encrypted; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.bot_instances.api_password_encrypted IS 'API password, encrypted by the C# application or migration script.';


--
-- Name: COLUMN bot_instances.linked_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.bot_instances.linked_at IS 'Timestamp when the WhatsApp account was successfully linked.';


--
-- Name: bot_instances_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.bot_instances_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.bot_instances_id_seq OWNER TO postgres;

--
-- Name: bot_instances_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.bot_instances_id_seq OWNED BY public.bot_instances.id;


--
-- Name: group_participants; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.group_participants (
    id integer NOT NULL,
    bot_instance_id integer NOT NULL,
    group_jid character varying(100) NOT NULL,
    participant_jid character varying(100) NOT NULL,
    display_name character varying(255),
    is_admin boolean DEFAULT false,
    last_fetched_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.group_participants OWNER TO postgres;

--
-- Name: TABLE group_participants; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.group_participants IS 'Stores participant information for groups managed by bot instances.';


--
-- Name: group_participants_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.group_participants_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.group_participants_id_seq OWNER TO postgres;

--
-- Name: group_participants_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.group_participants_id_seq OWNED BY public.group_participants.id;


--
-- Name: instance_logs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.instance_logs (
    id integer NOT NULL,
    bot_instance_id integer,
    log_level character varying(20),
    message text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.instance_logs OWNER TO postgres;

--
-- Name: TABLE instance_logs; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.instance_logs IS 'Persistent logs for bot instances.';


--
-- Name: instance_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.instance_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.instance_logs_id_seq OWNER TO postgres;

--
-- Name: instance_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.instance_logs_id_seq OWNED BY public.instance_logs.id;


--
-- Name: lid_resolutions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.lid_resolutions (
    id integer NOT NULL,
    bot_instance_id integer NOT NULL,
    lid_jid character varying(100) NOT NULL,
    resolved_phone_jid character varying(100) NOT NULL,
    display_name character varying(255),
    resolved_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.lid_resolutions OWNER TO postgres;

--
-- Name: TABLE lid_resolutions; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.lid_resolutions IS 'Cache for resolved LID (Linked Device ID) to phone number JIDs.';


--
-- Name: lid_resolutions_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.lid_resolutions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.lid_resolutions_id_seq OWNER TO postgres;

--
-- Name: lid_resolutions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.lid_resolutions_id_seq OWNED BY public.lid_resolutions.id;


--
-- Name: pending_lid_identifications; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.pending_lid_identifications (
    id integer NOT NULL,
    bot_instance_id integer NOT NULL,
    lid_jid character varying(100) NOT NULL,
    requested_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    message_key text
);


ALTER TABLE public.pending_lid_identifications OWNER TO postgres;

--
-- Name: TABLE pending_lid_identifications; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.pending_lid_identifications IS 'Tracks LIDs from whom a phone number identification has been requested.';


--
-- Name: pending_lid_identifications_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.pending_lid_identifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.pending_lid_identifications_id_seq OWNER TO postgres;

--
-- Name: pending_lid_identifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.pending_lid_identifications_id_seq OWNED BY public.pending_lid_identifications.id;


--
-- Name: whitelisted_groups; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.whitelisted_groups (
    id integer NOT NULL,
    bot_instance_id integer NOT NULL,
    group_jid character varying(100) NOT NULL,
    group_name character varying(255),
    is_active boolean DEFAULT true,
    added_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    added_by character varying(100),
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.whitelisted_groups OWNER TO postgres;

--
-- Name: TABLE whitelisted_groups; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.whitelisted_groups IS 'Stores whitelisted WhatsApp groups for each bot instance.';


--
-- Name: COLUMN whitelisted_groups.group_jid; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.whitelisted_groups.group_jid IS 'The JID of the WhatsApp group (e.g., xxxxx-yyyyy@g.us).';


--
-- Name: whitelisted_users; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.whitelisted_users (
    id integer NOT NULL,
    bot_instance_id integer NOT NULL,
    user_jid character varying(100) NOT NULL,
    phone_number character varying(30),
    display_name character varying(255),
    allowed_in_groups boolean DEFAULT true,
    api_contact_id integer,
    api_mobile character varying(30),
    api_active boolean DEFAULT true,
    is_synced boolean DEFAULT true,
    last_api_sync timestamp with time zone,
    added_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.whitelisted_users OWNER TO postgres;

--
-- Name: TABLE whitelisted_users; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.whitelisted_users IS 'Stores whitelisted WhatsApp users for each bot instance.';


--
-- Name: COLUMN whitelisted_users.user_jid; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.whitelisted_users.user_jid IS 'The JID of the WhatsApp user (e.g., 967xxxxxxxxx@s.whatsapp.net or a LID).';


--
-- Name: v_active_bot_instances; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.v_active_bot_instances AS
 SELECT bi.id,
    bi.client_id,
    bi.phone_number,
    bi.display_name,
    bi.status,
    bi.api_username,
    bi.owner_number,
    bi.linked_at,
    bi.last_seen,
    bi.created_at AS instance_created_at,
    bi.updated_at AS instance_updated_at,
    ( SELECT count(*) AS count
           FROM public.whitelisted_users wu
          WHERE ((wu.bot_instance_id = bi.id) AND (wu.api_active = true))) AS active_whitelisted_users_count,
    ( SELECT count(*) AS count
           FROM public.whitelisted_groups wg
          WHERE ((wg.bot_instance_id = bi.id) AND (wg.is_active = true))) AS active_whitelisted_groups_count,
    ( SELECT count(*) AS count
           FROM public.lid_resolutions lr
          WHERE (lr.bot_instance_id = bi.id)) AS resolved_lids_count,
    ( SELECT max(asl.completed_at) AS max
           FROM public.api_sync_log asl
          WHERE ((asl.bot_instance_id = bi.id) AND ((asl.sync_status)::text = 'completed'::text) AND ((asl.sync_type)::text = 'contacts'::text))) AS last_successful_contact_sync
   FROM public.bot_instances bi
  WHERE ((bi.status)::text <> 'deleted'::text);


ALTER TABLE public.v_active_bot_instances OWNER TO postgres;

--
-- Name: v_recent_api_syncs; Type: VIEW; Schema: public; Owner: postgres
--

CREATE VIEW public.v_recent_api_syncs AS
 SELECT asl.id AS sync_log_id,
    asl.bot_instance_id,
    bi.client_id,
    bi.phone_number AS bot_phone_number,
    bi.display_name AS bot_display_name,
    asl.sync_type,
    asl.sync_status,
    asl.contacts_fetched,
    asl.contacts_added,
    asl.contacts_updated,
    asl.contacts_removed,
    asl.error_message,
    asl.started_at AS sync_started_at,
    asl.completed_at AS sync_completed_at
   FROM (public.api_sync_log asl
     JOIN public.bot_instances bi ON ((bi.id = asl.bot_instance_id)))
  ORDER BY asl.started_at DESC
 LIMIT 100;


ALTER TABLE public.v_recent_api_syncs OWNER TO postgres;

--
-- Name: whitelisted_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.whitelisted_groups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.whitelisted_groups_id_seq OWNER TO postgres;

--
-- Name: whitelisted_groups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.whitelisted_groups_id_seq OWNED BY public.whitelisted_groups.id;


--
-- Name: whitelisted_users_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.whitelisted_users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.whitelisted_users_id_seq OWNER TO postgres;

--
-- Name: whitelisted_users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.whitelisted_users_id_seq OWNED BY public.whitelisted_users.id;


--
-- Name: api_sync_log id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.api_sync_log ALTER COLUMN id SET DEFAULT nextval('public.api_sync_log_id_seq'::regclass);


--
-- Name: asked_lids_cache id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.asked_lids_cache ALTER COLUMN id SET DEFAULT nextval('public.asked_lids_cache_id_seq'::regclass);


--
-- Name: bot_contacts id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.bot_contacts ALTER COLUMN id SET DEFAULT nextval('public.bot_contacts_id_seq'::regclass);


--
-- Name: bot_instances id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.bot_instances ALTER COLUMN id SET DEFAULT nextval('public.bot_instances_id_seq'::regclass);


--
-- Name: group_participants id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_participants ALTER COLUMN id SET DEFAULT nextval('public.group_participants_id_seq'::regclass);


--
-- Name: instance_logs id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.instance_logs ALTER COLUMN id SET DEFAULT nextval('public.instance_logs_id_seq'::regclass);


--
-- Name: lid_resolutions id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.lid_resolutions ALTER COLUMN id SET DEFAULT nextval('public.lid_resolutions_id_seq'::regclass);


--
-- Name: pending_lid_identifications id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pending_lid_identifications ALTER COLUMN id SET DEFAULT nextval('public.pending_lid_identifications_id_seq'::regclass);


--
-- Name: whitelisted_groups id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.whitelisted_groups ALTER COLUMN id SET DEFAULT nextval('public.whitelisted_groups_id_seq'::regclass);


--
-- Name: whitelisted_users id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.whitelisted_users ALTER COLUMN id SET DEFAULT nextval('public.whitelisted_users_id_seq'::regclass);


--
-- Name: api_sync_log api_sync_log_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.api_sync_log
    ADD CONSTRAINT api_sync_log_pkey PRIMARY KEY (id);


--
-- Name: asked_lids_cache asked_lids_cache_bot_instance_id_lid_jid_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.asked_lids_cache
    ADD CONSTRAINT asked_lids_cache_bot_instance_id_lid_jid_key UNIQUE (bot_instance_id, lid_jid);


--
-- Name: asked_lids_cache asked_lids_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.asked_lids_cache
    ADD CONSTRAINT asked_lids_cache_pkey PRIMARY KEY (id);


--
-- Name: bot_contacts bot_contacts_bot_instance_id_user_jid_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.bot_contacts
    ADD CONSTRAINT bot_contacts_bot_instance_id_user_jid_key UNIQUE (bot_instance_id, user_jid);


--
-- Name: bot_contacts bot_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.bot_contacts
    ADD CONSTRAINT bot_contacts_pkey PRIMARY KEY (id);


--
-- Name: bot_instances bot_instances_client_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.bot_instances
    ADD CONSTRAINT bot_instances_client_id_key UNIQUE (client_id);


--
-- Name: bot_instances bot_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.bot_instances
    ADD CONSTRAINT bot_instances_pkey PRIMARY KEY (id);


--
-- Name: group_participants group_participants_bot_instance_id_group_jid_participant_ji_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_participants
    ADD CONSTRAINT group_participants_bot_instance_id_group_jid_participant_ji_key UNIQUE (bot_instance_id, group_jid, participant_jid);


--
-- Name: group_participants group_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_participants
    ADD CONSTRAINT group_participants_pkey PRIMARY KEY (id);


--
-- Name: instance_logs instance_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.instance_logs
    ADD CONSTRAINT instance_logs_pkey PRIMARY KEY (id);


--
-- Name: lid_resolutions lid_resolutions_bot_instance_id_lid_jid_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.lid_resolutions
    ADD CONSTRAINT lid_resolutions_bot_instance_id_lid_jid_key UNIQUE (bot_instance_id, lid_jid);


--
-- Name: lid_resolutions lid_resolutions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.lid_resolutions
    ADD CONSTRAINT lid_resolutions_pkey PRIMARY KEY (id);


--
-- Name: pending_lid_identifications pending_lid_identifications_bot_instance_id_lid_jid_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pending_lid_identifications
    ADD CONSTRAINT pending_lid_identifications_bot_instance_id_lid_jid_key UNIQUE (bot_instance_id, lid_jid);


--
-- Name: pending_lid_identifications pending_lid_identifications_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pending_lid_identifications
    ADD CONSTRAINT pending_lid_identifications_pkey PRIMARY KEY (id);


--
-- Name: whitelisted_groups whitelisted_groups_bot_instance_id_group_jid_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.whitelisted_groups
    ADD CONSTRAINT whitelisted_groups_bot_instance_id_group_jid_key UNIQUE (bot_instance_id, group_jid);


--
-- Name: whitelisted_groups whitelisted_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.whitelisted_groups
    ADD CONSTRAINT whitelisted_groups_pkey PRIMARY KEY (id);


--
-- Name: whitelisted_users whitelisted_users_bot_instance_id_user_jid_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.whitelisted_users
    ADD CONSTRAINT whitelisted_users_bot_instance_id_user_jid_key UNIQUE (bot_instance_id, user_jid);


--
-- Name: whitelisted_users whitelisted_users_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.whitelisted_users
    ADD CONSTRAINT whitelisted_users_pkey PRIMARY KEY (id);


--
-- Name: idx_api_sync_log_bot_instance_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_api_sync_log_bot_instance_id ON public.api_sync_log USING btree (bot_instance_id);


--
-- Name: idx_api_sync_log_started_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_api_sync_log_started_at ON public.api_sync_log USING btree (started_at DESC);


--
-- Name: idx_api_sync_log_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_api_sync_log_status ON public.api_sync_log USING btree (sync_status);


--
-- Name: idx_asked_lids_cache_bot_instance_id_lid_jid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_asked_lids_cache_bot_instance_id_lid_jid ON public.asked_lids_cache USING btree (bot_instance_id, lid_jid);


--
-- Name: idx_bot_contacts_bot_instance_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_bot_contacts_bot_instance_id ON public.bot_contacts USING btree (bot_instance_id);


--
-- Name: idx_bot_contacts_phone_number; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_bot_contacts_phone_number ON public.bot_contacts USING btree (phone_number);


--
-- Name: idx_bot_contacts_user_jid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_bot_contacts_user_jid ON public.bot_contacts USING btree (user_jid);


--
-- Name: idx_bot_instances_phone_number; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_bot_instances_phone_number ON public.bot_instances USING btree (phone_number);


--
-- Name: idx_bot_instances_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_bot_instances_status ON public.bot_instances USING btree (status);


--
-- Name: idx_group_participants_bot_instance_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_group_participants_bot_instance_id ON public.group_participants USING btree (bot_instance_id);


--
-- Name: idx_group_participants_group_jid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_group_participants_group_jid ON public.group_participants USING btree (group_jid);


--
-- Name: idx_group_participants_participant_jid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_group_participants_participant_jid ON public.group_participants USING btree (participant_jid);


--
-- Name: idx_instance_logs_bot_instance_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_instance_logs_bot_instance_id ON public.instance_logs USING btree (bot_instance_id);


--
-- Name: idx_instance_logs_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_instance_logs_created_at ON public.instance_logs USING btree (created_at DESC);


--
-- Name: idx_lid_resolutions_bot_instance_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_lid_resolutions_bot_instance_id ON public.lid_resolutions USING btree (bot_instance_id);


--
-- Name: idx_lid_resolutions_lid_jid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_lid_resolutions_lid_jid ON public.lid_resolutions USING btree (lid_jid);


--
-- Name: idx_lid_resolutions_resolved_phone_jid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_lid_resolutions_resolved_phone_jid ON public.lid_resolutions USING btree (resolved_phone_jid);


--
-- Name: idx_pending_lid_identifications_bot_instance_id_lid_jid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_pending_lid_identifications_bot_instance_id_lid_jid ON public.pending_lid_identifications USING btree (bot_instance_id, lid_jid);


--
-- Name: idx_whitelisted_groups_bot_instance_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_whitelisted_groups_bot_instance_id ON public.whitelisted_groups USING btree (bot_instance_id);


--
-- Name: idx_whitelisted_groups_group_jid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_whitelisted_groups_group_jid ON public.whitelisted_groups USING btree (group_jid);


--
-- Name: idx_whitelisted_users_api_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_whitelisted_users_api_active ON public.whitelisted_users USING btree (api_active);


--
-- Name: idx_whitelisted_users_bot_instance_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_whitelisted_users_bot_instance_id ON public.whitelisted_users USING btree (bot_instance_id);


--
-- Name: idx_whitelisted_users_user_jid; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_whitelisted_users_user_jid ON public.whitelisted_users USING btree (user_jid);


--
-- Name: bot_instances update_bot_instances_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER update_bot_instances_updated_at BEFORE UPDATE ON public.bot_instances FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: whitelisted_groups update_whitelisted_groups_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER update_whitelisted_groups_updated_at BEFORE UPDATE ON public.whitelisted_groups FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: whitelisted_users update_whitelisted_users_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER update_whitelisted_users_updated_at BEFORE UPDATE ON public.whitelisted_users FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: api_sync_log api_sync_log_bot_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.api_sync_log
    ADD CONSTRAINT api_sync_log_bot_instance_id_fkey FOREIGN KEY (bot_instance_id) REFERENCES public.bot_instances(id) ON DELETE CASCADE;


--
-- Name: asked_lids_cache asked_lids_cache_bot_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.asked_lids_cache
    ADD CONSTRAINT asked_lids_cache_bot_instance_id_fkey FOREIGN KEY (bot_instance_id) REFERENCES public.bot_instances(id) ON DELETE CASCADE;


--
-- Name: bot_contacts bot_contacts_bot_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.bot_contacts
    ADD CONSTRAINT bot_contacts_bot_instance_id_fkey FOREIGN KEY (bot_instance_id) REFERENCES public.bot_instances(id) ON DELETE CASCADE;


--
-- Name: group_participants group_participants_bot_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_participants
    ADD CONSTRAINT group_participants_bot_instance_id_fkey FOREIGN KEY (bot_instance_id) REFERENCES public.bot_instances(id) ON DELETE CASCADE;


--
-- Name: instance_logs instance_logs_bot_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.instance_logs
    ADD CONSTRAINT instance_logs_bot_instance_id_fkey FOREIGN KEY (bot_instance_id) REFERENCES public.bot_instances(id) ON DELETE CASCADE;


--
-- Name: lid_resolutions lid_resolutions_bot_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.lid_resolutions
    ADD CONSTRAINT lid_resolutions_bot_instance_id_fkey FOREIGN KEY (bot_instance_id) REFERENCES public.bot_instances(id) ON DELETE CASCADE;


--
-- Name: pending_lid_identifications pending_lid_identifications_bot_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pending_lid_identifications
    ADD CONSTRAINT pending_lid_identifications_bot_instance_id_fkey FOREIGN KEY (bot_instance_id) REFERENCES public.bot_instances(id) ON DELETE CASCADE;


--
-- Name: whitelisted_groups whitelisted_groups_bot_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.whitelisted_groups
    ADD CONSTRAINT whitelisted_groups_bot_instance_id_fkey FOREIGN KEY (bot_instance_id) REFERENCES public.bot_instances(id) ON DELETE CASCADE;


--
-- Name: whitelisted_users whitelisted_users_bot_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.whitelisted_users
    ADD CONSTRAINT whitelisted_users_bot_instance_id_fkey FOREIGN KEY (bot_instance_id) REFERENCES public.bot_instances(id) ON DELETE CASCADE;


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT ALL ON SCHEMA public TO postgres;


--
-- PostgreSQL database dump complete
--

