/**
 * Folding Traditional Chinese onto Simplified, for comparison only.
 *
 * Two copies of the same song in different orthographies share almost no codepoints, and everything here
 * compares by character. 山對山來崖對崖 against 山对山来崖对崖 is the same words — a Traditional catalogue
 * answering a query typed in Simplified, or the reverse — and unfolded it reads as a different song.
 *
 * Measured, which is what prompted it. The matcher scores title × 0.5 + artist × 0.3 + duration × 0.2
 * against a 0.62 threshold. A variant *title* alone survives, because a matching artist and an exact
 * duration floor the score. What did not survive is the ordinary case, where the artist name is
 * variant-shifted too:
 *
 *     独角兽 / 吴青峰  against  獨角獸 / 吳青峰,  no duration:   0.467 — rejected
 *     the same, with an exact duration match:                  0.567 — rejected
 *
 * So correct lyrics were discarded as the wrong song even when the duration matched exactly. The app hit
 * this too and fixed it with ICU's `Hant-Hans`; Node exposes no transliterator, so this is a table.
 *
 * **Deliberately not applied in `foldTight`.** That feeds `cacheKey`, so folding there would change the
 * key of every Chinese track already cached: the old entries would never be read again, and the next play
 * would file a duplicate and re-fetch from every source. This is for comparison only.
 *
 * Characters whose Traditional form maps to different Simplified forms depending on meaning — 乾 to 干 or
 * 乾, 著 to 着 or 著 — are left out rather than guessed. A wrong fold makes two genuinely different
 * characters compare equal, and the point here is to prevent mistaken matches, not to cause a subtler
 * kind.
 */

/**
 * Traditional character followed by its Simplified form, repeatedly.
 *
 * Interleaved rather than two parallel strings, and that is the second attempt: parallel strings need
 * their lengths to agree *and* their positions to correspond, and the first draft was one character out
 * — caught only because a length check happened to be there. A pair that reads 萬万 is verifiable on
 * sight, and a missing character can only break its own pair instead of shifting every pair after it.
 */
const PAIRS =
  '萬万與与醜丑專专業业叢丛東东絲丝丟丢兩两嚴严喪丧個个豐丰臨临為为麗丽舉举麼么義义' +
  '烏乌樂乐喬乔習习鄉乡書书買买亂乱爭争於于虧亏雲云亞亚產产畝亩親亲嚇吓單单嗎吗迴回' +
  '麥麦們们億亿僅仅從从眾众優优會会傷伤傑杰傭佣僕仆儲储兒儿內内冊册寫写軍军農农馮冯' +
  '衝冲決决況况淨净涼凉淚泪淺浅渾浑滅灭滿满濁浊濃浓濕湿灣湾災灾無无煙烟熱热營营燈灯' +
  '爐炉爺爷爾尔牆墙歸归舊旧層层屬属嶼屿歲岁嶽岳峽峡島岛嶺岭嶄崭廟庙廠厂廣广廢废開开' +
  '閉闭問问閏闰閑闲間间閘闸閣阁閩闽閱阅閹阉閻阎闊阔關关闡阐隊队陣阵陝陕陽阳陰阴陳陈' +
  '隸隶隨随險险隱隐雜杂雞鸡難难靈灵靜静韌韧韓韩頁页頂顶頃顷項项順顺須须頑顽顧顾頓顿' +
  '頌颂預预領领頗颇頭头頸颈頻频顆颗題题額额顏颜願愿顛颠類类顯显風风飄飘飛飞飢饥飯饭' +
  '飲饮飾饰飽饱餅饼養养餓饿餘余館馆饅馒馬马馳驰馴驯駐驻駒驹駕驾駛驶騎骑騙骗騰腾驅驱' +
  '驕骄驗验驚惊髒脏體体髮发鬧闹鬥斗鬱郁魚鱼魯鲁鮮鲜鯨鲸鳥鸟鳳凤鳴鸣鴨鸭鴻鸿鵝鹅鶴鹤' +
  '鷹鹰鹹咸鹽盐麵面黃黄點点黨党齊齐齒齿齡龄龍龙龜龟來来時时過过還还這这進进對对說说' +
  '話话語语記记見见視视覺觉學学愛爱夢梦聲声車车長长門门風风計计訊讯討讨訓训託托訪访' +
  '設设許许訴诉評评詞词試试詩诗該该詳详認认誤误誰谁課课調调談谈誕诞請请諸诸謀谋講讲' +
  '謝谢識识譜谱譯译議议護护讀读變变讓让豬猪貓猫獨独獸兽環环現现離离氣气溫温準准潔洁' +
  '濟济濤涛濱滨煉炼燒烧爛烂牽牵獅狮獎奖獲获瑪玛瓊琼璽玺礦矿碼码礎础確确禮礼禍祸稱称' +
  '穀谷積积穎颖窮穷竊窃競竞筍笋築筑籃篮籌筹約约紅红紀纪納纳純纯紙纸級级紛纷紋纹紐纽' +
  '細细終终紹绍綁绑結结絕绝給给統统經经綠绿維维綜综緊紧緒绪線线編编緩缓締缔縣县縮缩' +
  '總总績绩織织繡绣繩绳繪绘繼继續续纖纤纏缠罰罚羅罗聯联聰聪肅肃腦脑膽胆臉脸舉举艱艰' +
  '艷艳藝艺藥药蘭兰蘇苏蟲虫術术衛卫裝装襯衬觀观觸触貝贝負负貼贴貴贵費费資资賀贺賣卖' +
  '賓宾賽赛贈赠贊赞賴赖賺赚輕轻輪轮載载車车農农鐘钟鑑鉴鋒锋錦锦錯错鈞钧鐵铁鍵键鏡镜' +
  '銀银錢钱鋼钢針针釣钓鈴铃鍋锅鮑鲍鯉鲤鰭鳍禎祯緻致縱纵繫系纔才' +
  '吳吴樣样傳传導导幾几樹树機机檢检歡欢權权燦灿猶犹獻献瑩莹畢毕疊叠發发盡尽監监盤盘' +
  '礙碍種种稅税竪竖筆笔節节範范簾帘簽签粵粤糧粮糰团罷罢羨羡聖圣聽听脫脱腳脚膚肤臥卧' +
  '蔔卜薑姜藍蓝蠻蛮詢询誠诚諾诺謎谜讚赞貢贡貨货販贩賢贤贏赢趙赵跡迹踐践軌轨軟软較较' +
  '輔辅輛辆轉转辦办邊边鄭郑醫医釋释閨闺雖虽電电顫颤驢驴鬆松鏈链錄录鍾钟閃闪陸陆雙双' +
  '壯壮妝妆將将狀状獎奖漿浆槳桨醬酱彊强強强';

const TABLE = (() => {
  const chars = [...PAIRS];
  if (chars.length % 2 !== 0) throw new Error(`han.ts: ${chars.length} characters is not pairs`);

  const map = new Map<string, string>();
  for (let i = 0; i < chars.length; i += 2) {
    const [traditional, simplified] = [chars[i], chars[i + 1]];
    // A pair of the same character is a typo, not a mapping, and would hide a real one.
    if (traditional === simplified) throw new Error(`han.ts: ${traditional} maps to itself`);
    const existing = map.get(traditional);
    if (existing && existing !== simplified) {
      throw new Error(`han.ts: ${traditional} maps to both ${existing} and ${simplified}`);
    }
    map.set(traditional, simplified);
  }
  return map;
})();

/** How many characters the table knows. Exported so a test can notice it being gutted. */
export const FOLDED_CHARACTERS = TABLE.size;

/**
 * Traditional characters replaced by their Simplified form.
 *
 * Everything else passes through untouched, so other scripts are unaffected and a character the table
 * does not know is left exactly as it was — unknown coverage degrades to the old behaviour rather than to
 * a wrong answer.
 */
export function toSimplified(value: string): string {
  // Overwhelmingly the common case: nothing to fold, and nothing allocated.
  let found = false;
  for (const ch of value) {
    if (TABLE.has(ch)) {
      found = true;
      break;
    }
  }
  if (!found) return value;

  let out = '';
  for (const ch of value) out += TABLE.get(ch) ?? ch;
  return out;
}
