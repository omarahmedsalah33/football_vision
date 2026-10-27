from experiments.report_player_stats import consolidate, summarize


CATALOG = [{"id": f"Unknown{i}"} for i in range(1, 13)]


def event(**changes):
    return {
        "id": "clip-1-e1", "clip_id": "clip-1", "actor_id": "Unknown9",
        "type": "shot", "outcome": "goal", "source_start_s": 28.2,
        "source_end_s": 29.4, "source_key_s": 28.8, "in_primary_window": True,
        "identity_confidence": "high", "event_confidence": "high", "evidence_level": "direct",
        **changes,
    }


def review(**changes):
    return {"action_verdict": "supported", "identity_verdict": "supported",
            "outcome_verdict": "inconclusive", **changes}


def test_neutral_astra_retains_gemini_goal_without_claiming_agreement():
    records = consolidate([event()], {"clip-1-e1": review()})
    p = summarize(records, CATALOG)[8]
    assert p["shots"] == 1
    assert p["goal_claims_supported"] == 0
    assert p["goals"] == 1
    assert p["unresolved_goal_claims"] == 0
    assert p["official_statistics"] is None


def test_neutral_action_and_identity_do_not_veto_gemini():
    records = consolidate([event(type="pass", outcome="completed")], {
        "clip-1-e1": review(action_verdict="inconclusive", identity_verdict="inconclusive")})
    p = summarize(records, CATALOG)[8]
    assert p["passes"] == p["completed_pass_proposals"] == 1
    assert "Astra neutral" in records[0]["decision_basis"]


def test_explicit_goal_contradiction_blocks_goal_but_not_shot():
    records = consolidate([event()], {"clip-1-e1": review(outcome_verdict="contradicted")})
    p = summarize(records, CATALOG)[8]
    assert p["shots"] == 1
    assert p["goals"] == 0
    assert p["unresolved_goal_claims"] == 1


def test_explicit_identity_contradiction_blocks_attribution():
    records = consolidate([event()], {"clip-1-e1": review(identity_verdict="contradicted")})
    assert summarize(records, CATALOG)[8]["shots"] == 0


def test_unaudited_gemini_goal_is_accepted_with_original_provenance():
    p = summarize(consolidate([event()], {}), CATALOG)[8]
    assert p["goals"] == 1 and p["goal_claims_supported"] == 0


def test_disputed_action_does_not_become_a_player_statistic():
    records = consolidate([event(type="pass", outcome="completed")],
                          {"clip-1-e1": review(action_verdict="contradicted")})
    p = summarize(records, CATALOG)[8]
    assert p["passes"] == 0
    assert p["awaiting_review"] == 1


def test_unassigned_action_is_not_credited_to_a_reference_player():
    records = consolidate([event(actor_id=None)], {})
    stats = summarize(records, CATALOG)
    assert len(stats) == 12
    assert all(p["shots"] == 0 for p in stats)


def test_cross_clip_overlapping_carry_is_not_counted_twice():
    first = event(type="carry", outcome="not_applicable")
    second = event(id="clip-2-e1", clip_id="clip-2", type="carry", outcome="not_applicable",
                   source_start_s=28.5, source_end_s=31, source_key_s=30)
    records = consolidate([first, second], {})
    assert summarize(records, CATALOG)[8]["carries"] == 1
    assert records[1]["possible_duplicate_of"] == first["id"]


def test_minute_buckets_use_source_event_time():
    records = consolidate([event(type="pass", outcome="unknown", source_start_s=65,
                                  source_end_s=66, source_key_s=65.5)], {})
    p = summarize(records, CATALOG)[8]
    assert [m["passes"] for m in p["minute_splits"]] == [0, 1, 0]


def test_uncertain_identity_is_not_hidden_as_a_definite_count():
    records = consolidate([event(identity_confidence="medium")], {})
    assert not records[0]["included_in_provisional_count"]
    assert summarize(records, CATALOG)[8]["awaiting_review"] == 1
