-- Extract C: one row per SSEID that answered the NPS survey.
--
-- "Cx Recommended" comes from the question
--   how_likely_are_you_to_recommend_solarsquare_to_a_friend_or_coll
-- in public.new_nps_response_live, on a 0-10 scale. Joined to the base on
-- sse_id = project.sseid.
--
-- Two things to know:
--
--   1. `sentiment` in this table is the sentiment of the free-text REASON, not
--      of the score -- score 10 appears with sentiment 'Negative' 37 times.
--      The score is the field that answers "would they recommend us".
--
--   2. A customer can answer more than once (12,253 responses over 9,687
--      SSEIDs). We take their HIGHEST score: the question is whether they have
--      ever expressed willingness to recommend. `submitteddate` is mixed-format
--      free text ('21/02/25 13:42' and 'Sep 9, 2024 9:12 AM' both occur), so
--      "most recent response" is not reliably derivable from it.
--
-- public.solarsquare_nps_response_live is the older, smaller feed (2,191 rows,
-- last activity 2023) and is deliberately not used.

SELECT
    TRIM(n."sse_id")                                        AS install_id,
    MAX(NULLIF(TRIM(n."how_likely_are_you_to_recommend_solarsquare_to_a_friend_or_coll"), '')::int)
                                                            AS nps_score,
    COUNT(*)                                                AS nps_responses
FROM public."new_nps_response_live" n
WHERE NULLIF(TRIM(n."sse_id"), '') IS NOT NULL
  AND TRIM(n."how_likely_are_you_to_recommend_solarsquare_to_a_friend_or_coll") ~ '^[0-9]+$'
GROUP BY 1
