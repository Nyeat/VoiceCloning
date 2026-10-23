"""Input failure paths; successful inference is covered by real GPU smoke runs."""
import json, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
import gradio as gr
import numpy as np
import soundfile as sf
import app
import run_model

class ValidationTests(unittest.TestCase):
    def call(self,**changes):
        args=dict(key='qwen',reference='missing.wav',transcript='A reference.',text='Hello.',language='English',seed=42,settings_text='{"temperature":0.9,"top_p":1.0}')
        args.update(changes)
        with patch.object(app,'status',return_value={'state':'installed'}):
            return app.generate(**args)

    def test_missing_reference(self):
        with self.assertRaisesRegex(gr.Error,'reference audio'): self.call(reference=None)
    def test_missing_transcript(self):
        with self.assertRaisesRegex(gr.Error,'exact reference transcript'): self.call(transcript='')
    def test_excessive_text(self):
        with self.assertRaisesRegex(gr.Error,'1200'): self.call(text='a'*1201)
    def test_wrong_language(self):
        with self.assertRaisesRegex(gr.Error,'supported language'): self.call(language='unsupported')
    def test_unknown_settings(self):
        with self.assertRaisesRegex(gr.Error,'exactly'): self.call(settings_text='{"shell":"ignored"}')
    def test_nonfinite_settings(self):
        with self.assertRaisesRegex(gr.Error,'finite'): self.call(settings_text='{"temperature":NaN,"top_p":1}')
    def test_out_of_range_settings(self):
        with self.assertRaisesRegex(gr.Error,'between'): self.call(settings_text='{"temperature":9,"top_p":1}')
    def test_silent_reference(self):
        with tempfile.TemporaryDirectory() as d:
            p=str(Path(d)/'silent.wav'); sf.write(p,np.zeros(4*16000),16000)
            with self.assertRaisesRegex(gr.Error,'silent'): self.call(reference=p)
    def test_short_reference(self):
        with tempfile.TemporaryDirectory() as d:
            p=str(Path(d)/'short.wav'); sf.write(p,np.zeros(16000),16000)
            with self.assertRaisesRegex(gr.Error,'3 and 30'): self.call(reference=p)
    def test_long_fire_reference(self):
        with tempfile.TemporaryDirectory() as d:
            p=str(Path(d)/'long.wav'); sf.write(p,0.1*np.ones(13*16000),16000)
            with self.assertRaisesRegex(gr.Error,'3–12'):
                self.call(key='fire',reference=p,settings_text='{"steps":10,"guidance":2.0}')
    def test_emotion_ignored_for_unsupported_model(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(app.emotion_request(app.MODELS['qwen'],'angry',0.6,'',None,Path(d)))
    def test_emotion_request_for_tags(self):
        with tempfile.TemporaryDirectory() as d:
            e=app.emotion_request(app.MODELS['fishs2'],'angry',0.9,'',None,Path(d))
            self.assertEqual((e['kind'],e['label']),('tags','angry'))
            self.assertEqual(run_model.emotion_phrase(e),'very angry')
            self.assertEqual(run_model.tag_sentences('Hi there. Bye!','very angry'),'[very angry] Hi there. [very angry] Bye!')
    def test_emotion_description_rejects_brackets(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(gr.Error,'brackets'):
                app.emotion_request(app.MODELS['vox'],'none',0.6,'angry] [happy',None,Path(d))
    def test_emotion_reference_only_for_index(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(gr.Error,'Only IndexTTS'):
                app.emotion_request(app.MODELS['fishs2'],'angry',0.6,'','clip.wav',Path(d))
    def test_uninstalled_model(self):
        with patch.object(app,'status',return_value={'state':'installation failed'}):
            with self.assertRaisesRegex(gr.Error,'not installed'):
                app.generate('qwen',None,'','Hello.','English',42,'{}')

if __name__=='__main__': unittest.main()
