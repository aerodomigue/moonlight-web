# Wake-on-LAN to routed private IPv4 addresses

The previous implementation rejected a paired PC with valid IP/MAC whenever its
address was outside a directly connected subnet. A regression assertion against
the previously deployed binary reproduces `network_unreachable` instead of
`available` for 192.168.5.191.

The sender now retains the existing broadcast target for on-link PCs and uses
UDP unicast to the saved private IP for other VLANs/subnets. Binding AnyIPv4 lets
the OS choose the route, gateway and source interface. Ports remain 7 and 9 and
the payload remains the 102-byte magic packet. Duplicate unicast targets are
removed. Public/loopback/multicast/non-IP targets remain excluded; no remote
broadcast mask is guessed. Known local self/network/broadcast destinations
remain excluded. An empty list of broadcast-capable interfaces does not prevent
private unicast, which also accommodates routed/tunnel interfaces.

ARP discovery deliberately uses only `broadcastTargets`, not the expanded WOL
target selection. Thus a routed PC never inherits the gateway MAC. Automatic IP
selection still prefers a usable directly connected IP when one is known. Manual
overrides, authenticated MAC precedence, and account/disabled-host guards remain
unchanged. The dashboard and configuration availability use the same target
selection as the sender; no frontend permission workaround is introduced.

The French, English and Chinese form descriptions and README explain that
successful transmission is not proof of wake-up. No router or firewall changes
are performed. Routed delivery to a powered-off NIC still depends on the network
and NIC behavior; private unicast is not a guaranteed replacement for a network
WOL relay or directed broadcast.

## Validation

- Unit coverage: routed private target with AnyIPv4 source, duplicate targets,
  no broadcast-capable interface, local broadcast, invalid destinations, ARP
  eligibility, MAC provenance and persisted configuration.
- HTTPS fixture: automatic routed IP/MAC becomes available and persists; real
  UDP listeners capture the exact magic packet on both ports in automatic and
  manual modes; a second SSO account cannot trigger a packet; public-IP override
  is rejected. Existing timeout, certificate, identity, disabled-record and
  failed-write cases are retained.
- UDP fixture must run in an isolated Linux network namespace with
  `192.168.5.191/32` assigned to its loopback and
  `net.ipv4.ip_unprivileged_port_start=0` set **inside that namespace only** so
  the non-root test process can listen on 7/9. Set
  `MW_WOL_TEST_IP=192.168.5.191`; otherwise that delivery test is skipped.
  These are temporary test interfaces/settings, never production/host networking.
- Chromium in French: offline wake button, automatic values and revised help on
  desktop/mobile; closing the form sends no WOL packet.
- Full frontend/backend, translations, static analysis and security suites;
  separately track the five pre-existing Linux Steam launcher failures.
