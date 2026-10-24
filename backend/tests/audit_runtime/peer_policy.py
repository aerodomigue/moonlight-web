"""Compile the current ICE peer-classification function without starting a PC."""
from pathlib import Path
import subprocess
import tempfile

source = Path('backend/src/main.cpp').read_text()
start = source.index('static NetClassify::Kind streamClientKind(')
end = source.index('\n// A browser', start)
program = (
    '#include "common/Types.h"\n#include "server/NetClassify.h"\n'
    '#include <QDebug>\n#include <iostream>\n' + source[start:end] + r'''
int main() {
    HttpRequest req;
    req.clientAddress = "10.2.100.122";
    req.viaProxy = true;
    req.hostTrusted = true;
    req.headers["host"] = "moonlight.navet.dev";
    req.headers["x-forwarded-for"] = "10.2.100.122";
    std::cout << "{\"resolved_peer\":\""
              << NetClassify::toString(NetClassify::classify(req.clientAddress))
              << "\",\"stream_class\":\""
              << NetClassify::toString(streamClientKind(req)) << "\"}" << std::endl;
}
''')
flags = subprocess.check_output(['pkg-config', '--cflags', '--libs', 'Qt6Core', 'Qt6Network'], text=True).split()
with tempfile.TemporaryDirectory(prefix='mw-audit-peer-') as directory:
    binary = str(Path(directory) / 'probe')
    subprocess.run(['c++', '-std=c++17', '-fPIC', '-Ibackend/src', '-x', 'c++', '-', '-o', binary, *flags],
                   input=program, text=True, check=True)
    subprocess.run([binary], check=True)
