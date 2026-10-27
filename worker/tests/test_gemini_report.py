from experiments.report_gemini import csv_cell


def test_csv_model_text_cannot_become_a_formula():
    assert csv_cell("=HYPERLINK(\"https://example.invalid\")").startswith("'=")
    assert csv_cell("  @SUM(A1)").startswith("'")
    assert csv_cell("player in blue") == "player in blue"
    assert csv_cell(18.5) == 18.5
