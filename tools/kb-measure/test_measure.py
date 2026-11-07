import unittest
from measure import has_source

class SourceRulerTest(unittest.TestCase):
    def test_explicit_references(self):
        for text in ['出处：《课程大纲》','依据：《教案》','来自《课程大纲》和《常见错误手册》。','来自「教学反思」']:
            self.assertTrue(has_source(text),text)
    def test_unattributed_text(self):
        for text in ['', '课堂练习先画图。', '这条意见来自课堂。']:
            self.assertFalse(has_source(text),text)

if __name__=='__main__':unittest.main()
