"""Build portable skill ZIPs without rebuilding any runtime payloads."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import stat
import zipfile

TARGETS = {"linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64"}


def executable(name):
    return name == "tracetoon/bin/tracetoon" or bool(
        re.fullmatch(r"tracetoon/bin/tracetoon-(?:linux|darwin)-[^/]+", name)
        and not name.endswith(".build.json")
    )


def sha(stream):
    return hashlib.file_digest(stream, "sha256").hexdigest()


def write_archive(destination, members):
    with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, source in sorted(members.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | (0o755 if executable(name) else 0o644)) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            info.file_size = source.stat().st_size
            with source.open("rb") as original, archive.open(info, "w") as output:
                shutil.copyfileobj(original, output)
    # Verify the serialized archive, including permissions and unmodified payloads.
    with zipfile.ZipFile(destination) as archive:
        if sorted(archive.namelist()) != sorted(members):
            raise ValueError("Archive inventory mismatch")
        for info in archive.infolist():
            wanted = stat.S_IFREG | (0o755 if executable(info.filename) else 0o644)
            if info.create_system != 3 or info.external_attr >> 16 != wanted:
                raise ValueError("Archive lost portable file permissions")
            with archive.open(info) as packed, members[info.filename].open("rb") as original:
                if sha(packed) != sha(original):
                    raise ValueError("Archive changed a candidate payload")


def package_candidate(skill, release):
    skill, release = Path(skill).resolve(strict=True), Path(release).resolve(strict=True)
    manifest = json.loads((skill / "build.json").read_text(encoding="utf-8"))
    targets = manifest["recipe"]["native"]["targets"]
    if len(targets) != len(TARGETS) or set(targets) != TARGETS:
        raise ValueError("Candidate platform set differs from the release protocol")
    members = {}
    for source in sorted(skill.rglob("*")):
        if source.is_symlink():
            raise ValueError("Candidate skill contains a symbolic link")
        if source.is_file():
            relative = source.relative_to(skill).as_posix()
            if re.match(r"bin/tracetoon-(?:linux|darwin|windows)-", relative):
                raise ValueError("Base skill contains stale platform runtimes")
            members["tracetoon/" + relative] = source
    if "tracetoon/bin/tracetoon" not in members or "tracetoon/SKILL.md" not in members:
        raise ValueError("Candidate skill is missing its launcher or instructions")
    outputs = [release / "tracetoon-skill.zip"]
    write_archive(outputs[0], members)
    for target in targets:
        binary = "tracetoon-" + target + (".exe" if target.startswith("windows-") else "")
        additions = {}
        for name in [binary, binary + ".build.json"]:
            source = release / name
            if source.is_symlink() or not source.is_file():
                raise ValueError("Candidate runtime or receipt is missing or linked")
            additions["tracetoon/bin/" + name] = source
        destination = release / ("tracetoon-skill-" + target + ".zip")
        write_archive(destination, {**members, **additions})
        outputs.append(destination)
    return outputs


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skill", required=True)
    parser.add_argument("--release", required=True)
    args = parser.parse_args()
    for output in package_candidate(args.skill, args.release):
        print("Verified portable archive: " + output.name)
