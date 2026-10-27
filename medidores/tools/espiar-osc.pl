#!/usr/bin/perl
# Resume el tráfico OSC entre una mesa y una app, leyendo la salida de tcpdump. Solo LEE: no envía nada.
#
# Uso (en la Terminal del Mac; sustituye en9 por tu adaptador y la IP por la de la mesa):
#   sudo tcpdump -l -n -i en9 -x host 192.168.102.121 | perl espiar-osc.pl 192.168.102.121
# Déjalo unos 30 s mientras usas la app y pulsa Ctrl+C: imprime el resumen. Copia ese texto.
#
# Muestra: los flujos (protocolo y puertos), los mensajes con "meter" en la dirección (con sus argumentos)
# y los demás mensajes más frecuentes. Los números de canal se agrupan como /N.
use strict;
use warnings;
$| = 1;

my $console = shift @ARGV || '';
my (%flows, %msgs, %bad, %req);
my ($bundles, $nonosc, @nonosc_samples) = (0, 0);
my ($hdr, @bytes);

$SIG{INT} = sub { finish_packet(); report(); exit 0; };

while (my $line = <STDIN>) {
    if ($line =~ /^\d\d:\d\d:\d\d\.\d+\s+IP6?\s+(\S+)\s+>\s+(\S+?):\s*(.*)$/) {
        finish_packet();
        $hdr = { src => $1, dst => $2, rest => $3 };
        @bytes = ();
    } elsif ($line =~ /^\s+0x[0-9a-f]+:\s+((?:[0-9a-f]{2,4}\s?)+)/i) {
        (my $h = $1) =~ s/\s+//g;
        push @bytes, map { hex } ($h =~ /(..)/g);
    }
}
finish_packet();
report();

sub split_port { my ($a) = @_; return $a =~ /^(.*)\.(\d+)$/ ? ($1, $2) : ($a, ''); }

sub finish_packet {
    return unless $hdr;
    my ($sip, $sp) = split_port($hdr->{src});
    my ($dip, $dp) = split_port($hdr->{dst});
    my $proto = $hdr->{rest} =~ /^UDP/ ? 'UDP' : $hdr->{rest} =~ /^Flags/ ? 'TCP' : 'otro';
    my $dir = $console ne '' && $sip eq $console ? 'MESA->APP' : 'APP->MESA';
    my $f = $flows{"$dir  $proto  puerto origen $sp -> puerto destino $dp"} ||= { n => 0, bytes => 0 };
    $f->{n}++;
    if ($proto eq 'UDP' && @bytes > 28) {
        my $ihl = ($bytes[0] & 0x0f) * 4;
        my $payload = pack('C*', @bytes[($ihl + 8) .. $#bytes]);
        $f->{bytes} += length $payload;
        parse_packet($payload, $dir);
    }
    undef $hdr;
    @bytes = ();
}

sub align4 { return ($_[0] + 3) & ~3; }

sub parse_packet {
    my ($s, $dir) = @_;
    if (length($s) >= 16 && substr($s, 0, 8) eq "#bundle\0") {
        $bundles++;
        my $off = 16;
        while ($off + 4 <= length $s) {
            my $size = unpack('N', substr($s, $off, 4));
            last if $size == 0 || $off + 4 + $size > length $s;
            parse_packet(substr($s, $off + 4, $size), $dir);
            $off += 4 + $size;
        }
        return;
    }
    my $z = index($s, "\0");
    if ($z < 1 || substr($s, 0, 1) ne '/') {
        $nonosc++;
        push @nonosc_samples, unpack('H*', substr($s, 0, 40)) if @nonosc_samples < 3;
        return;
    }
    my $addr = substr($s, 0, $z);
    my $off = align4($z + 1);
    my ($tags, @args) = ('', ());
    my $note = '';
    if ($off < length $s) {
        my $tz = index($s, "\0", $off);
        my $t = $tz < 0 ? '' : substr($s, $off, $tz - $off);
        if ($t =~ /^,/) {
            $tags = substr($t, 1);
            $off = align4($tz + 1);
            for my $c (split //, $tags) {
                if    ($c eq 'i' && $off + 4 <= length $s) { push @args, unpack('l>', substr($s, $off, 4)); $off += 4; }
                elsif ($c eq 'f' && $off + 4 <= length $s) { push @args, sprintf('%.4g', unpack('f>', substr($s, $off, 4))); $off += 4; }
                elsif ($c eq 's') { my $e = index($s, "\0", $off); last if $e < 0; push @args, '"' . substr($s, $off, $e - $off) . '"'; $off = align4($e + 1); }
                elsif ($c eq 'b' && $off + 4 <= length $s) { my $l = unpack('N', substr($s, $off, 4)); push @args, "<blob $l bytes>"; $off += 4 + align4($l); }
                elsif ($c eq 'T') { push @args, 'true'; }
                elsif ($c eq 'F') { push @args, 'false'; }
                else { push @args, "<tipo $c>"; last; }
            }
        } else {
            # OSC "sin etiquetas": tras la dirección vienen floats directamente
            my $rest = substr($s, $off);
            if (length($rest) >= 4 && length($rest) % 4 == 0 && length($rest) <= 64) {
                $note = 'SIN ETIQUETAS';
                @args = map { sprintf('%.4g', $_) } unpack('f>*', $rest);
            } else { $note = 'formato raro'; @args = (unpack('H*', substr($rest, 0, 24))); }
        }
    }
    if ($addr =~ m{^/Meters/request/(\d+)$}) { my $id = $1; $req{$id} = $1 if @args && $args[0] =~ /^"(.*)"$/; }
    my $tmpl = $addr;
    $tmpl =~ s{/\d+(?=/|$)}{/N}g unless $addr =~ m{^/Meters/}; # /Meters/request/7 conserva el número
    my $key = join("\t", $dir, $tmpl, $tags . ($note ? " [$note]" : ''));
    my $m = $msgs{$key} ||= { n => 0, sample => '' };
    $m->{n}++;
    $m->{sample} = substr('[' . join(', ', @args) . ']', 0, 110) if $m->{sample} eq '';
}

sub report {
    print "\n================ RESUMEN ================\n";
    print "FLUJOS (dirección, protocolo, puertos):\n";
    for my $k (sort { $flows{$b}{n} <=> $flows{$a}{n} } keys %flows) {
        printf "  %6d paquetes  %s\n", $flows{$k}{n}, $k;
    }
    print "Mensajes dentro de paquetes bundle: $bundles paquetes bundle\n" if $bundles;
    if ($nonosc) {
        print "Paquetes que no son OSC: $nonosc (primeros bytes en hexadecimal):\n";
        print "    $_\n" for @nonosc_samples;
    }
    my @keys = sort { $msgs{$b}{n} <=> $msgs{$a}{n} } keys %msgs;
    my @meter = grep { (split /\t/, $_)[1] =~ /meter/i } @keys;
    my %is = map { $_ => 1 } @meter;
    print "\nMENSAJES CON \"meter\" EN LA DIRECCIÓN:\n";
    print "  (ninguno)\n" unless @meter;
    printf "  %6d x  %-10s %s  %s   ej: %s\n", $msgs{$_}{n}, (split /\t/, $_)[0], (split /\t/, $_, -1)[1], (split /\t/, $_, -1)[2] // '', $msgs{$_}{sample} for @meter;
    if (%req) {
        print "\nMEDIDORES PEDIDOS POR LA APP (número -> ruta):\n";
        printf "  %4d  %s\n", $_, $req{$_} for sort { $a <=> $b } keys %req;
    }
    my @other = grep { !$is{$_} } @keys;
    my $max = 60;
    print "\nOTROS MENSAJES (los $max más frecuentes de " . scalar(@other) . "):\n";
    my $shown = 0;
    for my $k (@other) {
        last if $shown++ >= $max;
        my ($d, $a, $t) = split /\t/, $k, -1;
        printf "  %6d x  %-10s %s  %s   ej: %s\n", $msgs{$k}{n}, $d, $a, $t, $msgs{$k}{sample};
    }
    print "=========================================\n";
}
