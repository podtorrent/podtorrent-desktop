"""Restarting a node must not fail on the port its previous run just released."""

import socket
import threading
import time

from podtorrent import peer


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_free_port_is_free():
    assert peer.port_free(_free_port())


def test_listening_port_is_busy():
    with socket.socket() as srv:
        srv.bind(("127.0.0.1", 0))
        srv.listen()
        assert not peer.port_free(srv.getsockname()[1])


def test_time_wait_after_stop_does_not_block_restart():
    """The server closes first (as a stopped node does), leaving TIME_WAIT on its port."""
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    srv.listen()
    port = srv.getsockname()[1]
    client = socket.create_connection(("127.0.0.1", port))
    conn, _ = srv.accept()
    conn.close()      # active close on the server side -> TIME_WAIT on `port`
    client.close()
    srv.close()
    assert peer.port_free(port)


def test_wait_returns_once_old_node_exits():
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen()
    port = srv.getsockname()[1]
    threading.Timer(0.6, srv.close).start()
    t = time.monotonic()
    assert peer.wait_port_free(port, timeout=5)
    assert time.monotonic() - t >= 0.5


def test_wait_gives_up_when_port_stays_taken():
    with socket.socket() as srv:
        srv.bind(("127.0.0.1", 0))
        srv.listen()
        assert not peer.wait_port_free(srv.getsockname()[1], timeout=0.5)
