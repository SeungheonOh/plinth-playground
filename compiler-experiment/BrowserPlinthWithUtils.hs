{-# LANGUAGE ImportQualifiedPost #-}
{-# LANGUAGE TemplateHaskell #-}
{-# OPTIONS_GHC -fplugin-opt Plinth.Plugin:dump-uplc #-}

module Main where

import PlutusTx.Code (CompiledCode)
import PlutusTx.TH (compile)
import Utils (plusInteger)

addOne :: Integer -> Integer
addOne x = plusInteger x 1

compiledAddOne :: CompiledCode (Integer -> Integer)
compiledAddOne = $$(compile [||addOne||])

main :: IO ()
main = pure ()
