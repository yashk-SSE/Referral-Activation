-- Extract D: Installation Day Visit, keyed on SSEID.
--
-- Derived exactly as Metabase card 5318 does it, so the dashboard and the card
-- agree. IDV is a RECONNECTION MEETING in public.meeting_metrics_history:
--
--     meeting_type          = 'reconnection_meeting'
--     meeting_schedule_date -> IDV scheduled
--     meeting_done_date     -> IDV done
--
-- That it really is an installation-day activity is empirical, not naming: of
-- completed reconnection meetings against September installs, 35.5% land
-- exactly on the installation date, 28.7% the day before, and 79.7% inside
-- +/-3 days.
--
-- NO DATE WINDOW is applied, by decision -- this matches card 5318, which takes
-- whichever meeting it picks regardless of when it happened relative to the
-- installation. About a fifth of meetings sit outside +/-3 days, so these
-- counts are slightly broader than "installation day" taken literally. If a
-- window is wanted later, add it in transform.py rather than here, so it lives
-- next to the activation window it would need to agree with.
--
-- ONE MEETING PER SSEID, chosen by latest updatedAt, again matching 5318. This
-- is deliberately faithful rather than better: taking the LATEST-UPDATED row
-- is not the same as taking the one that was completed, and across all 10,241
-- SSEIDs with a reconnection meeting it reports no done date for 670 that do
-- have a completed meeting. On recent installs the cost is much smaller (12 of
-- 401 on September), because those customers usually have only one meeting.
-- Picking the meeting NEAREST INSTALLATION would be the honest rule; it would
-- also stop matching the card the team reads, so it is not done here.
--
-- meeting_schedule_date / meeting_done_date are already timestamptz, so they
-- take a SINGLE conversion to IST. The varchar recipe used on referrals
-- (CAST -> AT TIME ZONE 'UTC' -> AT TIME ZONE 'Asia/Kolkata') would shift these
-- twice and land them 5h30m out.

WITH picked AS (
    SELECT
        NULLIF(TRIM(m."sseid"), '')                          AS sseid,
        m."meeting_schedule_date"                            AS scheduled_at,
        m."meeting_done_date"                                AS done_at,
        ROW_NUMBER() OVER (
            PARTITION BY NULLIF(TRIM(m."sseid"), '')
            ORDER BY m."updatedAt" DESC NULLS LAST
        )                                                    AS rn
    FROM public.meeting_metrics_history m
    WHERE m."meeting_type" = 'reconnection_meeting'
      AND NULLIF(TRIM(m."sseid"), '') IS NOT NULL
)
SELECT
    sseid                                                    AS install_id,
    (scheduled_at AT TIME ZONE 'Asia/Kolkata')::date         AS idv_scheduled_date,
    (done_at      AT TIME ZONE 'Asia/Kolkata')::date         AS idv_done_date
FROM picked
WHERE rn = 1
