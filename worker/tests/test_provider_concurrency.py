from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
import time
from fa_worker.video_provider import VideoProvider


def test_parallel_responses_publish_checkpoints_serially(tmp_path):
    class Saved:
        active=0
        peak=0
        paths=[]
        def restore(self,path,progress):
            path.mkdir(exist_ok=True)
            return []
        def publish(self,path):
            self.active+=1
            self.peak=max(self.peak,self.active)
            time.sleep(.01)
            self.paths.append(path)
            self.active-=1
    saved=Saved()
    provider=VideoProvider(SimpleNamespace(storage_provider="replit",
        worker_storage_url="https://example.invalid/storage",worker_storage_token="unused",
        worker_id="test"),SimpleNamespace(id="test"),saved,tmp_path/"checkpoints",lambda:None)
    with ThreadPoolExecutor(max_workers=5) as pool:
        list(pool.map(lambda i:provider._save(str(i),result={"i":i}),range(5)))
    assert saved.peak==1
    assert len(saved.paths)==len(set(saved.paths))==len(provider.cache)==5
