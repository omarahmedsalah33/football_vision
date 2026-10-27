from experiments.report_astra import csv_cell, esc
from experiments.report_player_frames import timestamp


def test_model_comments_are_escaped_for_html():
    assert esc('<script>"claim"</script>') == "&lt;script&gt;&quot;claim&quot;&lt;/script&gt;"


def test_exported_model_comments_cannot_execute_spreadsheet_formulas():
    assert csv_cell("=SUM(A1)") == "'=SUM(A1)"
    assert csv_cell(" @SUM(A1)").startswith("'")
    assert csv_cell(28.5) == 28.5
    assert csv_cell(["frame-1"]) == '["frame-1"]'


def test_reference_timestamps_use_source_minutes_and_milliseconds():
    assert timestamp(28.5) == "00:28.500"
    assert timestamp(60) == "01:00.000"
    assert timestamp(59.9996) == "01:00.000"
