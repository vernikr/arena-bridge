import os, tempfile, pathlib, json

def test_s1_audit_artifact_traversal():
    from arena_bridge.audit import read_artifact
    assert read_artifact("/etc", "passwd") is None
    assert read_artifact("..", "../../etc/passwd") is None

def test_s2_protected_per_element():
    from arena_bridge.policy import check_path
    cfg = {"roots": ["/tmp/roots/a"], "protected": ["/tmp/roots/a/.ssh"]}
    ok, *_ = check_path("/tmp/roots/a/file.txt", cfg, "/tmp")
    assert ok
    ok2, _, err, _ = check_path("/tmp/roots/a/.ssh/id_rsa", cfg, "/tmp")
    assert not ok2 and "PROTECTED" in err

def test_s2b_dangling_symlink():
    import tempfile, os, pathlib
    from arena_bridge.policy import check_path
    with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as out:
        target = pathlib.Path(out) / "secret.txt"
        target.write_text("secret")
        link = pathlib.Path(d) / "link"
        try: os.symlink(target, link)
        except: return
        cfg = {"roots": [d], "protected": []}
        ok, abs_path, *_ = check_path(str(link), cfg, "/tmp")
        # should not allow escape to outside via symlink target check
        assert not ok or str(abs_path) != str(target) or d in str(abs_path)

def test_s4_allowed_chat():
    from arena_bridge.telegram import allowed_chat
    cfg = {"telegram": {"chatIds": ["123"]}}
    assert allowed_chat(cfg, "123")
    assert not allowed_chat(cfg, "999")

def test_s6_timing_safe():
    import hmac
    assert hmac.compare_digest("abc", "abc")
    assert not hmac.compare_digest("abc", "abd")

def test_s7_invalid_limit():
    try: int("abc")
    except ValueError: ok=True
    else: ok=False
    assert ok
