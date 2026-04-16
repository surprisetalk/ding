// Daily code golf bot — posts one programming challenge per day from a hardcoded bank.

import { botInit, getLastPostAge, post } from "../bots.ts";

const { apiUrl, auth, botUsername } = botInit("CODEGOLF");

const PROBLEMS = [
  {
    title: "FizzBuzz Sum",
    body:
      "Find the sum of all numbers below 1000 that are divisible by 3 or 5.\n\nExample: Below 10, the answer is 23 (3+5+6+9).",
    difficulty: "easy",
  },
  {
    title: "Collatz Length",
    body:
      "Find the starting number under 1,000,000 that produces the longest Collatz sequence.\n\nRules: if n is even, n→n/2; if odd, n→3n+1. Stop at 1.",
    difficulty: "medium",
  },
  {
    title: "Palindrome Product",
    body:
      "Find the largest palindrome made from the product of two 3-digit numbers.\n\nExample: 99 × 91 = 9009, the largest palindrome from two 2-digit numbers.",
    difficulty: "easy",
  },
  {
    title: "Triangle Numbers",
    body:
      "What is the first triangle number to have over 500 divisors?\n\nTriangle numbers: 1, 3, 6, 10, 15, 21, ... (the nth is n(n+1)/2).",
    difficulty: "medium",
  },
  {
    title: "Letter Frequency",
    body:
      'Write the shortest program that reads stdin and prints each unique letter (a-z, case-insensitive) with its count, sorted by frequency descending.\n\nExample: "hello" → l:2 h:1 e:1 o:1',
    difficulty: "easy",
  },
  {
    title: "Roman Numerals",
    body:
      "Write the shortest function that converts an integer (1-3999) to a Roman numeral string.\n\nExamples: 4→IV, 9→IX, 58→LVIII, 1994→MCMXCIV",
    difficulty: "easy",
  },
  {
    title: "Balanced Brackets",
    body:
      'Write the shortest program that checks if a string of brackets ()[]\\{\\} is balanced.\n\nExamples: "([])" → true, "([)]" → false, "" → true',
    difficulty: "easy",
  },
  {
    title: "Prime Spiral",
    body:
      "Print an Ulam spiral of size 9×9 to stdout. Mark primes with # and composites with .\n\nThe spiral starts at center with 1 and winds outward counterclockwise.",
    difficulty: "hard",
  },
  {
    title: "Largest Prime Factor",
    body: "What is the largest prime factor of 600851475143?\n\nShortest code wins.",
    difficulty: "easy",
  },
  {
    title: "Digit Fifth Powers",
    body:
      "Find the sum of all numbers that can be written as the sum of fifth powers of their digits.\n\nExample: 1634 = 1⁴ + 6⁴ + 3⁴ + 4⁴ (but with 5th powers).",
    difficulty: "medium",
  },
  {
    title: "ROT13",
    body:
      "Write the shortest ROT13 encoder/decoder. It should read stdin and write the ROT13'd text to stdout.\n\nOnly rotate a-z and A-Z, leave everything else unchanged.",
    difficulty: "easy",
  },
  {
    title: "Matrix Rotation",
    body:
      "Write the shortest function that rotates an NxN matrix 90° clockwise in-place.\n\nExample: [[1,2],[3,4]] → [[3,1],[4,2]]",
    difficulty: "medium",
  },
  {
    title: "Look and Say",
    body:
      'Generate the first 10 terms of the look-and-say sequence.\n\n1, 11, 21, 1211, 111221, ...\n\nEach term describes the previous: "one 1" → 11, "two 1s" → 21.',
    difficulty: "easy",
  },
  {
    title: "Sieve of Eratosthenes",
    body: "Print all primes below 10,000 using a sieve. Shortest code wins.\n\nOutput: one prime per line.",
    difficulty: "easy",
  },
  {
    title: "Game of Life",
    body:
      "Implement one step of Conway's Game of Life on a 20×20 grid. Read the grid from stdin (# = alive, . = dead), print the next generation.\n\nRules: alive with 2-3 neighbors survives; dead with exactly 3 neighbors is born.",
    difficulty: "hard",
  },
  {
    title: "Run-Length Encoding",
    body: 'Write the shortest program that compresses stdin with RLE.\n\nExample: "aaabbc" → "3a2b1c"',
    difficulty: "easy",
  },
  {
    title: "Happy Numbers",
    body:
      "Find the first 20 happy numbers.\n\nA number is happy if repeatedly summing the squares of its digits eventually reaches 1.\nExample: 7 → 49 → 97 → 130 → 10 → 1 (happy!)",
    difficulty: "easy",
  },
  {
    title: "Fibonacci Words",
    body:
      'Generate the first 8 Fibonacci words.\n\nStart: S₀="b", S₁="a". Then Sₙ = Sₙ₋₁ + Sₙ₋₂.\n\nb, a, ab, aba, abaab, abaababa, ...',
    difficulty: "easy",
  },
  {
    title: "Counting Sundays",
    body:
      "How many Sundays fell on the first of the month during the twentieth century (1 Jan 1901 to 31 Dec 2000)?\n\nNo date libraries allowed.",
    difficulty: "medium",
  },
  {
    title: "Power Digit Sum",
    body: "What is the sum of the digits of 2¹⁰⁰⁰?\n\nYou may use bigint.",
    difficulty: "easy",
  },
  {
    title: "Amicable Numbers",
    body:
      "Find the sum of all amicable numbers under 10000.\n\nTwo numbers are amicable if d(a)=b and d(b)=a where d(n) is the sum of proper divisors of n, and a≠b.",
    difficulty: "medium",
  },
  {
    title: "Spiral Matrix",
    body:
      "Write the shortest function that takes N and returns an N×N matrix filled with numbers 1 to N² in spiral order.\n\nExample N=3:\n1 2 3\n8 9 4\n7 6 5",
    difficulty: "medium",
  },
  {
    title: "Caesar Cipher",
    body:
      'Write the shortest program that encrypts stdin with a Caesar cipher of shift 13 (same as ROT13 but also shift digits 0-9 by 5).\n\nExample: "Hello 123" → "Uryyb 678"',
    difficulty: "easy",
  },
  {
    title: "Morse Code",
    body:
      "Write the shortest program that converts stdin (A-Z, 0-9, space) to Morse code.\n\nUse . and - with spaces between letters and / between words.",
    difficulty: "medium",
  },
  {
    title: "Diamond Pattern",
    body: "Given N, print a diamond of asterisks with width 2N-1.\n\nExample N=3:\n  *\n ***\n*****\n ***\n  *",
    difficulty: "easy",
  },
  {
    title: "Number to Words",
    body:
      'Write the shortest function that converts an integer (0-999999) to English words.\n\nExample: 42 → "forty two", 1001 → "one thousand one"',
    difficulty: "hard",
  },
  {
    title: "Luhn Check",
    body:
      "Write the shortest function that validates a credit card number using the Luhn algorithm.\n\nExample: 4539578763621486 → true, 1234567890123456 → false",
    difficulty: "easy",
  },
  {
    title: "Abundant Numbers",
    body:
      "Find the smallest number that cannot be written as the sum of two abundant numbers.\n\nA number is abundant if the sum of its proper divisors exceeds it.",
    difficulty: "hard",
  },
  {
    title: "Permutation Index",
    body:
      "What is the millionth lexicographic permutation of the digits 0123456789?\n\nDon't brute-force — use the factorial number system.",
    difficulty: "medium",
  },
  {
    title: "Champernowne",
    body:
      "Find d₁ × d₁₀ × d₁₀₀ × d₁₀₀₀ × d₁₀₀₀₀ × d₁₀₀₀₀₀ × d₁₀₀₀₀₀₀ of Champernowne's constant.\n\n0.123456789101112131415...",
    difficulty: "medium",
  },
  {
    title: "Brainf**k Interpreter",
    body:
      "Write the shortest Brainf**k interpreter. Read program from first line of stdin, input from second line.\n\nOps: > < + - . , [ ]",
    difficulty: "hard",
  },
  {
    title: "Quine",
    body:
      "Write the shortest quine in your language of choice.\n\nA quine is a program that outputs its own source code, with no input.",
    difficulty: "hard",
  },
  {
    title: "Pythagorean Triplet",
    body: "Find the product abc where a+b+c=1000 and a²+b²=c².\n\nThere is exactly one such Pythagorean triplet.",
    difficulty: "easy",
  },
  {
    title: "Coin Sums",
    body: "How many ways can you make £2 using any number of coins?\n\nCoins: 1p, 2p, 5p, 10p, 20p, 50p, £1, £2.",
    difficulty: "medium",
  },
  {
    title: "Pandigital Prime",
    body:
      "What is the largest n-digit pandigital prime?\n\nA pandigital number uses each digit 1 to n exactly once. Example: 2143 is 4-digit pandigital.",
    difficulty: "medium",
  },
  {
    title: "Kaprekar's Routine",
    body:
      "Starting from any 4-digit number (not all digits same), how many steps does Kaprekar's routine take to reach 6174?\n\nSort digits desc - sort digits asc = next number. Find the number under 10000 that takes the most steps.",
    difficulty: "medium",
  },
  {
    title: "Towers of Hanoi",
    body:
      'Print the moves to solve Towers of Hanoi with N=6 disks.\n\nFormat: one move per line, e.g. "1->3" means move disk from peg 1 to peg 3.',
    difficulty: "easy",
  },
  {
    title: "Self-Describing Number",
    body:
      "Find all self-describing numbers under 100,000,000.\n\nA self-describing number has digit d at position i meaning the digit i appears d times. Example: 2020 (two 0s, zero 1s, two 2s, zero 3s).",
    difficulty: "medium",
  },
  {
    title: "Benford's Law",
    body:
      "Verify Benford's Law for the first 1000 Fibonacci numbers. Print the frequency of each leading digit (1-9) as a percentage.\n\nBenford predicts: log₁₀(1 + 1/d)",
    difficulty: "medium",
  },
  {
    title: "Zigzag Cipher",
    body:
      'Implement a rail fence cipher with 3 rails.\n\nEncode: "WEAREDISCOVERED" with 3 rails → "WECRLTEERDSOAIVD"\n\nWrite shortest encoder AND decoder.',
    difficulty: "medium",
  },
  {
    title: "Narcissistic Numbers",
    body:
      "Find all narcissistic numbers up to 1,000,000.\n\nA narcissistic number equals the sum of its digits each raised to the power of the number of digits.\nExample: 153 = 1³ + 5³ + 3³",
    difficulty: "easy",
  },
  {
    title: "Perfect Shuffle",
    body:
      "How many perfect (out-)shuffles does it take to restore a deck of 52 cards to its original order?\n\nAn out-shuffle splits the deck in half and interleaves, keeping the top card on top.",
    difficulty: "easy",
  },
  {
    title: "Langton's Ant",
    body:
      "Simulate 11,000 steps of Langton's Ant on a 100×100 grid. Print the final grid.\n\nRules: on white → turn right, flip, move; on black → turn left, flip, move.",
    difficulty: "medium",
  },
  {
    title: "Reverse Polish",
    body:
      'Write the shortest RPN calculator. Read an expression like "3 4 + 2 *" from stdin and print the result.\n\nSupport: + - * / (integer division)',
    difficulty: "easy",
  },
  {
    title: "ISBN Validator",
    body:
      "Write the shortest program that validates both ISBN-10 and ISBN-13 checksums.\n\nISBN-10: sum of d_i * i (i=1..10) mod 11 = 0\nISBN-13: alternating weights 1,3",
    difficulty: "medium",
  },
  {
    title: "Mandelbrot ASCII",
    body:
      'Render the Mandelbrot set as 60×30 ASCII art to stdout.\n\nUse characters: " .:-=+*#%@" for increasing iteration counts. Max 100 iterations.',
    difficulty: "medium",
  },
  {
    title: "Parentheses Generator",
    body:
      "Print all valid combinations of N pairs of parentheses (N=4).\n\nExample N=2: (()), ()()\nExample N=3: ((())), (()()), (())(), ()(()), ()()()",
    difficulty: "easy",
  },
  {
    title: "Number Names Length",
    body:
      'If all the numbers from 1 to 1000 were written out in words, how many letters would be used?\n\nDon\'t count spaces or hyphens. Example: 342 = "three hundred and forty two" = 23 letters.',
    difficulty: "medium",
  },
  {
    title: "Magic Square",
    body:
      "Generate a 5×5 magic square where all rows, columns, and diagonals sum to the same value.\n\nUse numbers 1-25. Print the grid.",
    difficulty: "medium",
  },
  {
    title: "Anagram Finder",
    body:
      "Find the longest pair of anagrams in /usr/share/dict/words (or a word list of your choice).\n\nTwo words are anagrams if they contain the same letters in different order.",
    difficulty: "medium",
  },
];

async function main() {
  const ageHours = (await getLastPostAge(auth, botUsername, apiUrl)) / 3_600_000;
  console.log(`Last post was ${ageHours.toFixed(1)}h ago`);
  if (ageHours < 20) {
    console.log("Too soon for a new challenge, skipping");
    return;
  }

  const dayIndex = Math.floor(Date.now() / 86_400_000) % PROBLEMS.length;
  const problem = PROBLEMS[dayIndex];
  const dayNum = Math.floor(Date.now() / 86_400_000) - 20818;
  const body =
    `Day ${dayNum}: ${problem.title} [${problem.difficulty}]\n\n${problem.body}\n\nReply with your solution in any language. Shortest wins!`;
  console.log(`Posting: Day ${dayNum}: ${problem.title}`);
  if (!await post(auth, apiUrl, body, "#codegolf #game #bot")) Deno.exit(1);
  console.log("Posted!");
}

main();
