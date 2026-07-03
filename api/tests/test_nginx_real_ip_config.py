"""P0-1: the committed nginx config must validate CF-Connecting-IP against
Cloudflare ranges (set_real_ip_from) instead of blindly trusting the header."""

from pathlib import Path

NGINX = Path(__file__).resolve().parents[1] / "nginx"


def test_real_ip_conf_exists_and_sets_directives():
    conf = (NGINX / "cloudflare-real-ip.conf").read_text()
    assert "real_ip_header CF-Connecting-IP" in conf
    assert "set_real_ip_from" in conf
    assert "real_ip_recursive on" in conf


def test_locations_forward_validated_remote_addr_not_raw_header():
    loc = (NGINX / "oyechats-locations.conf").read_text()
    assert "$http_cf_connecting_ip" not in loc, "raw client header must no longer be forwarded"
    assert "X-Real-IP $remote_addr" in loc
