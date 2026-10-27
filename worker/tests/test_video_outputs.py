from fa_worker.video_outputs import output_keys


def test_interrupted_output_manifest_cannot_cross_job_boundaries():
    root="orgs/org/matches/match/analysis/job/"
    job={"org_id":"org","match_id":"match","id":"job","config":{"_videoOutputs":{
        "photos":[root+"players/1.jpg",root+"players/1.jpg","orgs/other/matches/m/analysis/j/players/1.jpg",
                  root+"players/../secret.jpg",root+"checkpoints/file.jpg"],
        "ledger":root+"tracks.jsonl.gz"}}}
    assert output_keys(job,True)==[root+"players/1.jpg"]
    assert output_keys(job)==[root+"players/1.jpg",root+"tracks.jsonl.gz"]
