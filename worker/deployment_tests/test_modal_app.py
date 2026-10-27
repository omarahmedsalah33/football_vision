"""Local deployment-contract tests; never starts Modal compute or touches a real database."""

from __future__ import annotations

import sys
import unittest
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import MagicMock, patch

import football_vision.worker.modal_app as deployment


@dataclass
class TestSettings:
    database_url: str = "postgresql://unused.invalid/test"
    work_dir: Path = Path("/tmp/unused")
    worker_id: str = "test-worker"
    lease_seconds: int = 60


class ModalDeploymentTests(unittest.TestCase):
    def setUp(self):
        parent = ModuleType("fa_worker")
        self.queue = ModuleType("fa_worker.queue")
        self.queue.connect = MagicMock()
        self.queue.claim = MagicMock()
        self.queue.reap_expired = MagicMock()
        self.queue.ClaimedJob = SimpleNamespace
        self.maintenance = ModuleType("fa_worker.maintenance")
        self.maintenance.run_sweeps = MagicMock(return_value=None)
        config = ModuleType("fa_worker.config")
        config.Settings = MagicMock()
        config.Settings.from_env.return_value = TestSettings()
        storage = ModuleType("fa_worker.storage")
        storage.get_storage = MagicMock()
        pipeline = ModuleType("fa_worker.pipeline")
        pipeline.process = MagicMock()
        pipeline.process.return_value = "succeeded"
        self.process = pipeline.process
        website = ModuleType("fa_worker.website_api")
        website.WebsiteAPI = MagicMock()
        self.api = website.WebsiteAPI.return_value
        self.state = {"ready": True, "protocol": "worker-api-v1", "pending": True}
        self.claimed = None
        self.api.request.side_effect = lambda op=None, **kw: (
            self.state if op is None else {"job": self.claimed, "video": {}, "leaseSeconds": 120}
            if op == "claim" else {})
        parent.queue = self.queue
        parent.maintenance = self.maintenance
        modules = {
            "fa_worker": parent,
            "fa_worker.queue": self.queue,
            "fa_worker.maintenance": self.maintenance,
            "fa_worker.config": config,
            "fa_worker.storage": storage,
            "fa_worker.pipeline": pipeline,
            "fa_worker.website_api": website,
        }
        self.addCleanup(patch.stopall)
        patch.object(deployment, "_website_ready", return_value=True).start()
        patch.dict(sys.modules, modules).start()
        self.conn = self.queue.connect.return_value.__enter__.return_value
        self.cur = self.conn.cursor.return_value.__enter__.return_value
        self.cur.fetchone.return_value = {"ready": True}
        self.stats = patch.object(deployment.process_one, "get_current_stats").start()
        self.stats.return_value = SimpleNamespace(num_running_inputs=0, backlog=0)
        self.spawn = patch.object(deployment.process_one, "spawn").start()
        self.spawn.return_value = SimpleNamespace(object_id="test-call")

    def test_empty_queue_does_not_allocate_gpu(self):
        self.state["pending"] = False
        self.assertEqual(deployment.dispatch.local(), {"status": "idle"})
        self.stats.assert_not_called()
        self.spawn.assert_not_called()
        self.api.request.assert_any_call("maintenance")
        self.queue.connect.assert_not_called()

    def test_running_gpu_does_not_spawn_another_input(self):
        self.stats.return_value.num_running_inputs = 1
        self.assertEqual(deployment.dispatch.local(), {"status": "busy"})
        self.spawn.assert_not_called()

    def test_backlog_does_not_spawn_another_input(self):
        self.stats.return_value.backlog = 1
        self.assertEqual(deployment.dispatch.local(), {"status": "busy"})
        self.spawn.assert_not_called()

    def test_ready_queue_starts_one_gpu_invocation(self):
        self.assertEqual(deployment.dispatch.local(), {"status": "dispatched", "callId": "test-call"})
        self.spawn.assert_called_once_with()
        self.api.request.assert_any_call("maintenance")
        self.queue.connect.assert_not_called()

    def test_database_failure_does_not_start_paid_compute(self):
        self.api.request.side_effect = ConnectionError("test website unavailable")
        self.assertEqual(deployment.dispatch.local(), {"status": "waiting_for_website"})
        self.spawn.assert_not_called()

    def test_unpublished_website_does_not_claim_jobs(self):
        self.state["protocol"] = "old-website"
        self.assertEqual(deployment.dispatch.local(), {"status": "waiting_for_website"})
        self.queue.connect.assert_not_called()
        self.spawn.assert_not_called()

    def run_gpu(self, *, cuda: bool, job=None):
        torch = ModuleType("torch")
        torch.cuda = SimpleNamespace(is_available=lambda: cuda)
        self.claimed = vars(job) if job else None
        with patch.dict(sys.modules, {"torch": torch}):
            return deployment.process_one.local()

    def test_ai_orchestration_does_not_require_a_gpu(self):
        self.assertEqual(self.run_gpu(cuda=False), {"status": "idle"})
        self.api.request.assert_called_once_with("claim")
        self.queue.connect.assert_not_called()
        self.process.assert_not_called()

    def test_no_claimable_job_exits_without_analysis(self):
        self.assertEqual(self.run_gpu(cuda=True), {"status": "idle"})
        self.process.assert_not_called()

    def test_claimed_job_uses_existing_pipeline_once(self):
        job = SimpleNamespace(id="test-job", kind="analyze")
        self.assertEqual(
            self.run_gpu(cuda=True, job=job),
            {"status": "succeeded", "jobId": "test-job", "kind": "analyze"},
        )
        self.process.assert_called_once()
        self.assertEqual(vars(self.process.call_args.args[-1]), vars(job))
        self.assertIs(self.process.call_args.args[0], self.api)
        self.queue.connect.assert_not_called()


if __name__ == "__main__":
    unittest.main()
