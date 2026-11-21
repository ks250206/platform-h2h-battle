import { angleDelta, canStandAt, length, normalize } from "./combat";
import { BattleEngine } from "./engine";
import { DEFAULT_MATCH_OPTIONS, type ControlDevice } from "./match";
import { NO_GIMMICKS } from "./rules";
import { safeZoneAt, type ZoneCircle } from "./safeZone";
import { INPUT_BUFFER_TICKS, RULES } from "./tuning";
import { emptyInput, type Fighter, type PlayerInput, type Vec2 } from "./types";

export const LESSONS = [
  {
    id: "basics",
    title: "移動・ジャンプ・照準",
    recap: "ロックオンで相手を向いても、剣が届く間合いまでは自分で近づく。",
    steps: ["相手に近づく", "地上からジャンプ", "相手を狙って剣を当てる"],
  },
  {
    id: "attacks",
    title: "技の間合いとため",
    recap: "突きは速くて長い。振り下ろしは重く、ためると威力と吹き飛びが増す。",
    steps: [
      "発生が速く、遠くに届く突きを短押しで当てる",
      "間合いを詰め、重い振り下ろしを約0.9秒ためて当てる",
    ],
  },
  {
    id: "dodge",
    title: "地上回避と空中回避",
    recap: "空中回避は滞空ごとに1回。着地すると再び使える。",
    steps: [
      "地上でステップ",
      "跳んですぐに空中回避",
      "ステップの終わりに空中で再び回避を押し、回数制限を試す",
      "着地して空中回避を回復",
      "もう一度跳び、空中回避を使う",
    ],
  },
  {
    id: "cancel",
    title: "ため・前隙のキャンセル",
    recap: "ためと前隙は取り消せる。振り切った後は後隙が終わるまで待つ。",
    steps: ["攻撃をためている間か、放して振りかぶっている間に取り消す"],
  },
  {
    id: "throw",
    title: "つかみと投げ",
    recap: "近くでつかみ、保持中の移動方向で投げ先を決める。",
    steps: ["相手の正面に密着してつかむ", "移動方向で投げ先を決め、投げが成立するまで待つ"],
  },
  {
    id: "ko",
    title: "蓄積ダメージ・撃墜・残機",
    recap: "蓄積%が高い相手ほど遠くへ飛ぶ。場外落下で残機が1つ減り、最後の残機を失うと脱落する。",
    steps: ["縁にいる120%の相手に剣を当てて吹き飛ばす", "相手を場外へ落とし、残機を1つ奪う"],
  },
  {
    id: "recovery",
    title: "場外からの復帰",
    recap: "地上で跳び、空中回避と振り上げ・突きで足場へ戻る。",
    steps: [
      "縁からジャンプして場外練習を始める",
      "場外の空中から、足場に向けて回避",
      "空中で振り上げか突きを出し切る",
      "足場へ向かって移動し、着地する",
    ],
  },
  {
    id: "zone",
    title: "移動するセーフゾーン",
    recap: "実線の外ではゲージと%が増える。破線が示す次の円へ先回りする。",
    steps: [
      "実線の円の外で、%とエリア外ゲージの増加を見る",
      "実線の円に入り、移動に合わせて破線の予告円へ向かう",
    ],
  },
  {
    id: "ukemi",
    title: "吹き飛びからの受け身",
    recap: "着地直前に回避を押し直す。方向を入れるとその方向へ転がる。",
    steps: ["相手に近づき、突きを受ける", "方向を入れ、着地直前に回避を押し直して転がる"],
  },
] as const;

export type LessonId = (typeof LESSONS)[number]["id"];
const NO_PLAYER_INPUTS: ReadonlyMap<number, PlayerInput> = new Map();
export type TutorialStatus = "playing" | "success" | "failed";
const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
const inside = (point: Vec2, circle: ZoneCircle) => distance(point, circle) <= circle.radius;

/** An independent battle with its own CPU, clock, buffers and scoring. Never reused for a match. */
export class TutorialBattle extends BattleEngine {
  readonly completed = new Set<LessonId>();
  lesson: (typeof LESSONS)[number] = LESSONS[0];
  step = 0;
  status: TutorialStatus = "playing";
  feedback = "";
  private successAt = 0;
  private approachFrom = 0;
  private destination: ZoneCircle | null = null;
  private enteredPreview = false;
  private awaitingAirStep = false;
  private aimed = false;

  begin(id: LessonId, device: ControlDevice): void {
    this.lesson = LESSONS.find((lesson) => lesson.id === id)!;
    this.step = 0;
    this.status = "playing";
    this.feedback = "";
    this.destination = null;
    this.enteredPreview = this.awaitingAirStep = this.aimed = false;
    this.start("duel", {
      ...DEFAULT_MATCH_OPTIONS,
      controls: { 0: device },
      stocks: 2,
      time: "short",
      gimmicks: { ...NO_GIMMICKS, safeZone: id === "zone" },
    });
    const state = this.state;
    state.phase = "playing";
    state.countdown = 0;
    const [p, rival] = state.fighters;
    p.x = 0;
    rival.x = id === "basics" || id === "ukemi" ? 4 : id === "throw" ? 1 : 2;
    rival.z = p.z = 0;
    p.facing = Math.PI / 2;
    rival.facing = -Math.PI / 2;
    if (id === "ko") {
      p.x = state.arena.halfSize - 2;
      rival.x = p.x + 1.6;
      rival.damage = 120;
    }
    if (id === "recovery") {
      p.x = state.arena.halfSize - 0.6;
      rival.x = 1;
      p.facing = -Math.PI / 2;
    }
    if (id === "zone") {
      // The third warning of a short match announces a circle disjoint from the current one.
      state.elapsed = 49.05;
      state.arena.safeZone = safeZoneAt(state.arena.stageId, state.elapsed, state.rules.timeLimit);
      const zone = state.arena.safeZone;
      p.x = zone.x - zone.radius - 1;
      p.z = rival.z = zone.z;
      rival.x = zone.x;
    }
    this.approachFrom = distance(p, rival);
  }

  protected override ai(f: Fighter): PlayerInput {
    const input = emptyInput();
    if (this.lesson.id === "zone") {
      const zone = this.state.arena.safeZone;
      if (distance(f, zone) > 0.5) input.move = normalize({ x: zone.x - f.x, z: zone.z - f.z });
    }
    if (this.lesson.id === "ukemi" && this.step === 0) {
      const p = this.state.fighters[0];
      input.aim = { x: p.x - f.x, z: p.z - f.z };
      if (distance(p, f) < 2.5 && f.mode === "idle") input.attackPressed = "thrust";
    }
    return input;
  }

  private advance(): void {
    this.feedback = "";
    this.step++;
    if (this.step === this.lesson.steps.length) {
      this.status = "success";
      this.successAt = this.state.elapsed;
      this.completed.add(this.lesson.id);
    }
  }

  private fail(reason: string): void {
    this.status = "failed";
    this.feedback = reason;
  }

  /** Let the player see the blow, throw or roll finish before a dialog covers the arena. */
  get resultReady(): boolean {
    return (
      this.status === "failed" ||
      (this.status === "success" &&
        (this.state.phase === "ended" || this.state.elapsed - this.successAt >= 0.55))
    );
  }

  protected override tick(dt: number, inputs: ReadonlyMap<number, PlayerInput>): void {
    if (this.state.phase !== "playing" || this.resultReady) return;
    if (this.status === "success") {
      super.tick(dt, NO_PLAYER_INPUTS);
      return;
    }
    const [p, rival] = this.state.fighters;
    const input = inputs.get(p.id) ?? emptyInput();
    if (this.awaitingAirStep) {
      if (!input.step) {
        if (input.jump || input.attackPressed || input.grab || input.cancel)
          this.feedback = "空中で一時停止中：まずは足場方向へ回避を押そう。";
        return;
      }
      this.awaitingAirStep = false;
    }
    const before = {
      mode: p.mode,
      ground: p.grounded,
      airStep: p.airStepUsed,
      stamina: p.stamina,
      bufferedStep: p.inputBuffer?.action === "step" && p.inputBuffer.age < INPUT_BUFFER_TICKS,
      x: p.x,
      z: p.z,
      hits: this.state.playerStats[0].landedSwings,
      stocks: rival.stocks,
      ko: p.kills,
      rivalDamage: rival.damage,
      grabbed: rival.grabbedBy,
    };
    super.tick(dt, inputs);
    const hit = this.state.playerStats[0].landedSwings > before.hits && rival.lastAttacker === p.id;
    const moved = length(input.move) > 0.00001 && distance(before, p) > 0.001;
    const jumped = before.ground && !p.grounded && p.vy > 0 && p.mode === "idle";
    const airStep = !before.airStep && p.airStepUsed && !p.grounded && p.mode === "step";
    const landed = !before.ground && p.grounded;
    if (p.mode === "dead") {
      this.fail(
        p.eliminationReason === "場外に落下"
          ? "足場に戻る前に場外へ落ちました。"
          : "エリア外ゲージがいっぱいになりました。",
      );
      return;
    }

    switch (this.lesson.id) {
      case "basics":
        if (this.step === 0 && moved && distance(p, rival) < this.approachFrom - 0.65)
          this.advance();
        else if (this.step === 1 && jumped) this.advance();
        else if (this.step === 2) {
          const aim = input.aim;
          const heading = Math.atan2(rival.x - p.x, rival.z - p.z);
          const facingRival = Math.abs(angleDelta(p.facing, heading)) < 0.35;
          if (!facingRival) this.aimed = false;
          else if (
            aim &&
            length(aim) > 0.05 &&
            !input.step &&
            (before.mode === "idle" || before.mode === "charge" || before.mode === "windup")
          )
            this.aimed = Math.abs(angleDelta(Math.atan2(aim.x, aim.z), heading)) < 0.35;
          if (hit) {
            if (this.aimed) this.advance();
            else this.feedback = "相手へ照準（ロックオンまたは照準操作）を合わせて当てよう。";
          }
        }
        break;
      case "attacks":
        if (
          hit &&
          ((this.step === 0 && p.attack === "thrust" && p.charge < 0.2) ||
            (this.step === 1 && p.attack === "overhead" && p.charge >= 0.85))
        )
          this.advance();
        else if (hit)
          this.feedback =
            this.step === 0 ? "突きを短く押して放そう。" : "振り下ろしを約0.9秒ためてから放そう。";
        break;
      case "dodge":
        if (this.step === 0 && before.ground && before.mode !== "step" && p.mode === "step")
          this.advance();
        else if ((this.step === 1 || this.step === 4) && airStep) this.advance();
        else if (
          this.step === 2 &&
          before.airStep &&
          before.stamina >= RULES.stepCost &&
          (input.step || before.bufferedStep) &&
          p.mode === "idle" &&
          !p.grounded &&
          p.airStepUsed &&
          !p.inputBuffer
        )
          this.advance();
        else if (this.step === 2 && landed)
          this.fail(
            "2回目の回避を試す前に着地しました。跳んだ直後に1回、ステップの終わりにもう1回押そう。",
          );
        else if (this.step === 3 && landed && !p.airStepUsed) this.advance();
        break;
      case "cancel":
        if (
          input.cancel &&
          (before.mode === "charge" || before.mode === "windup") &&
          p.mode === "cancel"
        )
          this.advance();
        else if (
          input.cancel &&
          (before.mode === "active" ||
            before.mode === "recovery" ||
            p.mode === "active" ||
            p.mode === "recovery")
        )
          this.fail(
            "取消が遅すぎました。ため中か振りかぶり中に押そう。剣の判定中と後隙には取り消せません。",
          );
        break;
      case "throw":
        if (this.step === 0 && rival.grabbedBy === p.id && p.grabbedId === rival.id) this.advance();
        else if (
          this.step === 1 &&
          before.grabbed === p.id &&
          rival.grabbedBy === null &&
          rival.lastAttacker === p.id &&
          rival.damage > before.rivalDamage &&
          rival.mode === "hitstun"
        )
          this.advance();
        else if (before.mode === "grab" && p.mode === "recovery")
          this.feedback = "つかみが届きませんでした。相手の正面に密着してもう一度。";
        break;
      case "ko":
        if (this.step === 0 && hit && before.rivalDamage >= 120 && rival.pendingLaunch)
          this.advance();
        else if (
          this.step === 1 &&
          rival.eliminationReason === "場外に落下" &&
          rival.stocks < before.stocks &&
          p.kills > before.ko
        )
          this.advance();
        break;
      case "recovery":
        if (this.step === 0 && jumped) {
          this.advance();
          // Stage this airborne drill only after the player's own grounded jump. Give time to read.
          Object.assign(p, {
            x: this.state.arena.halfSize + 3.3,
            z: 0,
            y: 6.5,
            vy: 0,
            facing: -Math.PI / 2,
          });
          this.awaitingAirStep = true;
        } else if (this.step === 1 && airStep) this.advance();
        else if (
          this.step === 2 &&
          !before.ground &&
          before.mode === "windup" &&
          p.mode === "active" &&
          (p.attack === "rising" || p.attack === "thrust")
        )
          this.advance();
        else if (this.step === 3 && landed && canStandAt(this.state, p.x, p.z)) this.advance();
        else if (this.step >= 1 && landed)
          this.fail("復帰技を出す前に着地しました。空中回避の終わりに振り上げか突きを短く押そう。");
        break;
      case "zone": {
        const zone = this.state.arena.safeZone;
        if (
          this.step === 0 &&
          p.outsideTime >= 0.6 &&
          p.damage > 0 &&
          zone.motion === "warning" &&
          zone.destination
        ) {
          this.destination = zone.destination;
          this.advance();
        }
        if (this.destination && this.step === 1) {
          if (
            (moved || p.mode === "step") &&
            distance(p, this.destination) < distance(before, this.destination) &&
            inside(p, this.destination)
          )
            this.enteredPreview = true;
          if (
            this.enteredPreview &&
            (zone.motion === "travel" || zone.motion === "hold") &&
            inside(p, this.destination) &&
            inside(p, zone)
          )
            this.advance();
          else if (zone.motion === "hold" && !inside(p, zone))
            this.fail("予告された移動が終わりました。破線の円内に入り、実線の円が来るまで待とう。");
        }
        break;
      }
      case "ukemi":
        if (this.step === 0 && p.lastAttacker === rival.id && p.mode === "hitstun" && p.tumbling)
          this.advance();
        else if (
          this.step === 1 &&
          before.mode === "ukemi" &&
          p.mode === "ukemi" &&
          length(p.stepDirection) > 0 &&
          distance(before, p) > 0.05
        )
          this.advance();
        else if (this.step === 1 && landed && (p.mode !== "ukemi" || length(p.stepDirection) === 0))
          this.fail(
            p.mode === "ukemi"
              ? "その場受け身に成功。今度は方向を入れて転がろう。"
              : "受け身を逃しました。着地まで約0.17秒の間に回避を押し直そう。",
          );
        else if (this.step === 1 && before.mode === "ukemi" && p.mode === "idle")
          this.fail("転がる先に足場がありませんでした。広い方向を選ぼう。");
        else if (this.step === 0 && rival.mode === "recovery" && p.lastAttacker === null)
          this.fail("相手の突きが外れました。正面から近づき、吹き飛ばされるのを待とう。");
        break;
    }
    if (this.status !== "playing") return;
    if (rival.mode === "dead") this.fail("課題の達成前に相手が退場しました。");
    else if (this.state.drawReason === "timeUp" || this.state.winnerId !== null)
      this.fail("練習時間が終了しました。");
  }
}
